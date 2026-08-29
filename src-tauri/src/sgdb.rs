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
pub fn best_for_steam_app(
    client: &reqwest::blocking::Client,
    key: &str,
    app_id: &str,
    want: Want,
) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    let url = format!("{BASE}/{}/steam/{app_id}", want.path());
    let response = client
        .get(&url)
        .query(&want.query())
        .bearer_auth(key)
        .send()
        .ok()?;

    if response.status() == 401 || response.status() == 403 {
        log_warn!("sgdb", "key rejected — check it in Settings");
        return None;
    }
    if !response.status().is_success() {
        log_debug!(
            "sgdb",
            "{} for {app_id}: {}",
            want.path(),
            response.status()
        );
        return None;
    }

    let body: Response = response.json().ok()?;
    if !body.success {
        log_debug!("sgdb", "{} for {app_id}: {:?}", want.path(), body.errors);
        return None;
    }
    // Ordered by the API's own ranking, so the first acceptable one is the
    // community's preferred choice rather than ours.
    body.data
        .into_iter()
        .find(|a| want.accepts(a.width, a.height))
        .map(|a| a.url)
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
        assert!(best_for_steam_app(&client, "", "1091500", Want::Grid).is_none());
    }

    #[test]
    fn animated_assets_are_never_requested() {
        for want in [Want::Grid, Want::Hero, Want::Logo] {
            assert!(want.query().contains(&("types", "static")), "{want:?}");
        }
    }
}
