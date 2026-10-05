//! SteamGridDB, the fallback artwork source for covers, logos and heroes that
//! Steam's CDN lacks. It needs only a free per-user key, so no proxy or server
//! (docs/PLAN.md §6). Optional: with no key it does nothing.

use serde::Deserialize;

use crate::{log_debug, log_warn};

const BASE: &str = "https://www.steamgriddb.com/api/v2";
pub const SETTING_KEY: &str = "steamgriddb_key";

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Vec<Asset>,
    #[serde(default)]
    errors: Vec<String>,
}

#[derive(Deserialize)]
struct Game {
    id: u64,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Vec<Game>,
}

#[derive(Deserialize)]
struct Asset {
    url: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
}

/// What to ask for, and how to recognise a good answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    /// Portrait box art.
    Grid,
    /// Wide key art for the backdrop.
    Hero,
    /// Transparent wordmark.
    Logo,
}

impl Want {
    fn path(self) -> &'static str {
        match self {
            Want::Grid => "grids",
            Want::Hero => "heroes",
            Want::Logo => "logos",
        }
    }

    /// Static only: an animated card repaints every frame (docs/PLAN.md §4).
    fn query(self) -> Vec<(&'static str, &'static str)> {
        let mut q = vec![("types", "static")];
        match self {
            Want::Grid => q.push(("dimensions", "600x900,660x930,512x512")),
            Want::Hero => q.push(("dimensions", "1920x620,3840x1240")),
            Want::Logo => {}
        }
        q
    }

    /// The API's dimension filter is advisory, so check the shape ourselves.
    fn accepts(self, width: u32, height: u32) -> bool {
        if width == 0 || height == 0 {
            return true; // unknown; let the download decide
        }
        let ratio = width as f32 / height as f32;
        match self {
            Want::Grid => ratio < 1.0,
            Want::Hero => ratio > 1.8,
            Want::Logo => true,
        }
    }
}

/// Each candidate is a download to validate, and popular games have hundreds.
const MAX_CANDIDATES: usize = 8;

/// Usable candidate URLs from a response, in the API's ranking order.
fn candidates_from(body: &Response, want: Want) -> Vec<String> {
    if !body.success {
        return Vec::new();
    }
    body.data
        .iter()
        .filter(|a| want.accepts(a.width, a.height))
        .filter(|a| !a.url.trim().is_empty())
        .take(MAX_CANDIDATES)
        .map(|a| a.url.clone())
        .collect()
}

/// Every usable asset URL for a Steam appid, best first. A list because any
/// one submission may be a dead link or a placeholder. Empty on any failure.
pub fn candidates_for_steam_app(
    client: &reqwest::blocking::Client,
    key: &str,
    app_id: &str,
    want: Want,
) -> Vec<String> {
    if key.is_empty() {
        return Vec::new();
    }
    fetch_candidates(
        client,
        key,
        &format!("{BASE}/{}/steam/{app_id}", want.path()),
        want,
    )
}

/// Shared by both lookups so they cannot drift apart in what they accept.
fn fetch_candidates(
    client: &reqwest::blocking::Client,
    key: &str,
    url: &str,
    want: Want,
) -> Vec<String> {
    let Ok(response) = client.get(url).query(&want.query()).bearer_auth(key).send() else {
        return Vec::new();
    };

    if response.status() == 401 || response.status() == 403 {
        log_warn!("sgdb", "key rejected — check it in Settings");
        return Vec::new();
    }
    if !response.status().is_success() {
        log_debug!("sgdb", "{url}: {}", response.status());
        return Vec::new();
    }

    let Ok(body) = response.json::<Response>() else {
        return Vec::new();
    };
    if !body.success {
        log_debug!("sgdb", "{url}: {:?}", body.errors);
        return Vec::new();
    }
    let out = candidates_from(&body, want);
    log_debug!(
        "sgdb",
        "{url}: {} of {} submissions usable",
        out.len(),
        body.data.len()
    );
    out
}

/// A SteamGridDB entry, for the artwork picker.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// SteamGridDB's own game id, not a Steam appid.
    pub id: String,
    pub name: String,
    /// First available grid, so a result looks like the card it will become.
    pub cover: String,
}

/// Search SteamGridDB by name. The artwork picker searches here rather than
/// the Steam store, which cannot help when Steam's own art is what is missing.
pub fn search(client: &reqwest::blocking::Client, key: &str, term: &str) -> Vec<Entry> {
    if key.is_empty() || term.trim().len() < 2 {
        return Vec::new();
    }
    let url = format!("{BASE}/search/autocomplete/{}", urlencode(term.trim()));
    let Ok(response) = client.get(&url).bearer_auth(key).send() else {
        return Vec::new();
    };
    if response.status() == 401 || response.status() == 403 {
        log_warn!("sgdb", "key rejected — check it in Settings");
        return Vec::new();
    }
    let Ok(body) = response.json::<SearchResponse>() else {
        return Vec::new();
    };
    if !body.success {
        return Vec::new();
    }

    // Each thumbnail costs a request, so only the first few results get one.
    const WITH_ART: usize = 6;
    body.data
        .into_iter()
        .take(WITH_ART)
        .map(|g| Entry {
            cover: candidates_for_game(client, key, g.id, Want::Grid)
                .into_iter()
                .next()
                .unwrap_or_default(),
            id: g.id.to_string(),
            name: g.name,
        })
        .collect()
}

/// Assets for a SteamGridDB game id, as opposed to a Steam appid.
pub fn candidates_for_game(
    client: &reqwest::blocking::Client,
    key: &str,
    game_id: u64,
    want: Want,
) -> Vec<String> {
    fetch_candidates(
        client,
        key,
        &format!("{BASE}/{}/game/{game_id}", want.path()),
        want,
    )
}

/// Percent-encode a search term for use as a path segment.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "%20".to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_is_required_for_a_cover_and_wide_for_a_hero() {
        assert!(Want::Grid.accepts(600, 900));
        assert!(!Want::Grid.accepts(1920, 620), "a banner is not box art");
        assert!(!Want::Grid.accepts(512, 512), "a square is not box art");

        assert!(Want::Hero.accepts(1920, 620));
        assert!(!Want::Hero.accepts(600, 900));

        assert!(Want::Logo.accepts(1000, 200));
        assert!(Want::Logo.accepts(400, 400));
    }

    #[test]
    fn unknown_dimensions_are_accepted_and_judged_on_download() {
        assert!(Want::Grid.accepts(0, 0));
        assert!(Want::Hero.accepts(0, 900));
    }

    #[test]
    fn no_key_means_no_request() {
        let client = reqwest::blocking::Client::new();
        assert!(candidates_for_steam_app(&client, "", "1091500", Want::Grid).is_empty());
    }

    fn body(assets: &[(u32, u32, &str)]) -> Response {
        Response {
            success: true,
            errors: Vec::new(),
            data: assets
                .iter()
                .map(|(w, h, url)| Asset {
                    url: (*url).into(),
                    width: *w,
                    height: *h,
                })
                .collect(),
        }
    }

    #[test]
    fn every_usable_submission_is_offered_in_order() {
        let got = candidates_from(
            &body(&[(600, 900, "a"), (600, 900, "b"), (660, 930, "c")]),
            Want::Grid,
        );
        assert_eq!(got, vec!["a", "b", "c"], "ranking order must be preserved");
    }

    #[test]
    fn wrong_shapes_are_filtered_out_of_the_list() {
        let got = candidates_from(
            &body(&[
                (1920, 620, "banner"),
                (600, 900, "cover"),
                (512, 512, "square"),
            ]),
            Want::Grid,
        );
        assert_eq!(got, vec!["cover"]);
    }

    #[test]
    fn the_candidate_list_is_bounded() {
        let many: Vec<(u32, u32, String)> = (0..50).map(|i| (600, 900, format!("u{i}"))).collect();
        let refs: Vec<(u32, u32, &str)> =
            many.iter().map(|(w, h, u)| (*w, *h, u.as_str())).collect();
        assert_eq!(
            candidates_from(&body(&refs), Want::Grid).len(),
            MAX_CANDIDATES
        );
    }

    #[test]
    fn an_unsuccessful_or_empty_response_yields_nothing() {
        assert!(candidates_from(&body(&[]), Want::Grid).is_empty());
        let failed = Response {
            success: false,
            errors: vec!["nope".into()],
            data: Vec::new(),
        };
        assert!(candidates_from(&failed, Want::Grid).is_empty());
    }

    /// A blank URL would otherwise use up one of the eight slots.
    #[test]
    fn blank_urls_are_skipped() {
        let got = candidates_from(&body(&[(600, 900, "   "), (600, 900, "real")]), Want::Grid);
        assert_eq!(got, vec!["real"]);
    }

    #[test]
    fn animated_assets_are_never_requested() {
        for want in [Want::Grid, Want::Hero, Want::Logo] {
            assert!(want.query().contains(&("types", "static")), "{want:?}");
        }
    }
}
