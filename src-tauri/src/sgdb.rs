//! SteamGridDB: the second source of artwork.
//!
//! Steam's own CDN is not enough, and the gaps are not edge cases. Recent
//! releases publish a grey placeholder where a portrait cover should be,
//! plenty of games have no transparent wordmark at all, and anything Steam
//! never sold has nothing. SteamGridDB is community-maintained and covers all
//! three, keyed by Steam appid so it slots in behind what we already have.
//!
//! It needs a free per-user key — generated from a profile page, **no client
//! secret**, so no proxy and no server. That is the whole reason it is the
//! chosen second source rather than something needing infrastructure; see
//! docs/PLAN.md §6.
//!
//! Strictly optional. With no key configured this does nothing at all, and the
//! interface must stay entirely usable in that state.

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

    /// Query parameters, tuned per kind.
    ///
    /// Animated assets are excluded everywhere: an APNG in a card is a
    /// per-frame repaint for every visible tile, which is exactly the cost
    /// docs/PLAN.md §4 spends its rules avoiding.
    fn query(self) -> Vec<(&'static str, &'static str)> {
        let mut q = vec![("types", "static")];
        match self {
            // The design is built on 2:3 box art. Asking for the right shape
            // avoids picking up a square or a banner and cropping it badly.
            Want::Grid => q.push(("dimensions", "600x900,660x930,512x512")),
            Want::Hero => q.push(("dimensions", "1920x620,3840x1240")),
            Want::Logo => {}
        }
        q
    }

    /// Is this asset the right shape to use?
    ///
    /// SteamGridDB's dimension filter is advisory and its data is community
    /// supplied, so the answer is checked rather than assumed.
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

/// The best asset URL for a Steam appid, or None.
///
/// Never an error: this is a fallback, and a fallback that can fail loudly is
/// worse than one that quietly does not apply.
/// How many community submissions to consider for one asset.
///
/// Bounded rather than unlimited: a popular game can have hundreds, each one is
/// a download to validate, and if the first eight are all unusable the ninth
/// will not save the day.
const MAX_CANDIDATES: usize = 8;

/// Pull the usable candidate URLs out of a response, in the API's own ranking
/// order.
///
/// Separated from the request so the filtering can be tested without a key or
/// a network, which is the part that actually decides what appears on screen.
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

/// Every usable asset URL for a Steam appid, best first.
///
/// A list rather than one URL, and that is the point: SteamGridDB is community
/// submitted, so a given entry may be a dead link, the wrong shape despite its
/// metadata, or an image that turns out to be a placeholder once downloaded.
/// Taking only the top-ranked one meant a single bad submission left a game
/// with no artwork while a dozen good ones sat behind it.
///
/// Never an error: this is a fallback, and a fallback that fails loudly is
/// worse than one that quietly does not apply.
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

/// One request-and-parse path, shared by the Steam-appid and SteamGridDB-id
/// lookups so they cannot drift apart in what they accept.
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

/// Search SteamGridDB by name.
///
/// The artwork picker searched the *Steam store*, which cannot help a game
/// whose Steam artwork is the thing that is missing -- picking the obvious
/// match just re-pointed a game at its own appid and changed nothing. This
/// searches the source that actually has the art.
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

    // A thumbnail per result costs a request each, so only the first few get
    // one. A picker with eight rows and no pictures is not a picker.
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

/// Percent-encode a search term. Game names contain spaces, colons and
/// apostrophes, all of which break a bare path segment.
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

        // A wordmark is any shape at all.
        assert!(Want::Logo.accepts(1000, 200));
        assert!(Want::Logo.accepts(400, 400));
    }

    /// Community data, so dimensions are sometimes absent. Unknown must not
    /// mean rejected, or a perfectly good asset is discarded unseen.
    #[test]
    fn unknown_dimensions_are_accepted_and_judged_on_download() {
        assert!(Want::Grid.accepts(0, 0));
        assert!(Want::Hero.accepts(0, 900));
    }

    /// With no key this must do nothing, without a request and without an
    /// error -- the whole source is optional.
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

    /// The reason this returns a list at all. Community submissions include
    /// dead links and mislabelled images, so one bad top-ranked entry must not
    /// leave a game blank while a dozen good ones sit behind it.
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

    /// A popular game can have hundreds of submissions and each one is a
    /// download to validate. If the first eight are unusable the ninth will
    /// not save the day.
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

    /// A blank URL is not a candidate, and would otherwise waste one of the
    /// eight slots on a guaranteed failure.
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
