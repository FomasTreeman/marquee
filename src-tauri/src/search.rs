//! Finding a game by name.
//!
//! This is the whole custom-game flow, per docs/PLAN.md §5: you type
//! *"Hollow Knight"*, pick it from results with cover art, and it lands in the
//! library complete with metadata and artwork. Pointing at an executable is a
//! separate, later step.
//!
//! `store.steampowered.com/api/storesearch` needs no key. That it is Steam's
//! index does not make this a Steam feature: a Steam **store page** exists for
//! most PC games whoever sold them, so a GOG or Epic or EA copy is identified
//! here and then borrows Steam's artwork by appid.

use serde::Serialize;

use crate::{log_info, log_warn};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub app_id: String,
    pub name: String,
    /// Which catalogue this came from: `steam` or `sgdb`.
    ///
    /// Not cosmetic. A Steam hit carries an appid that unlocks metadata --
    /// description, genres, release date, playtime -- and a SteamGridDB hit
    /// carries only artwork. The interface has to add them differently, and
    /// the person choosing deserves to know which they are getting.
    pub source: &'static str,
    /// Steam's own thumbnail for this result.
    ///
    /// A last resort only. The interface builds its cover from the appid so a
    /// result goes through the same artwork pipeline as a card -- placeholder
    /// detection, fallbacks, cache -- and therefore looks exactly like the card
    /// it is about to become. This is what to show if even that finds nothing.
    pub thumbnail: String,
}

fn hits_from(body: &serde_json::Value) -> Vec<SearchHit> {
    body.get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let app_id = item.get("id")?.as_u64()?.to_string();
                    let name = item.get("name")?.as_str()?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    Some(SearchHit {
                        source: "steam",
                        thumbnail: item
                            .get("tiny_image")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        app_id,
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Find a game by name, from every catalogue we have.
///
/// Steam first, because a Steam hit carries an appid and an appid carries
/// metadata -- description, genres, release date -- while a SteamGridDB hit
/// carries artwork and nothing else.
///
/// SteamGridDB is asked only when Steam draws a blank, and that case is not
/// rare: **Steam's store index only contains games Steam currently sells.**
/// Rocket League was delisted in 2020 and returns zero results, so "Add a
/// game" simply could not add it -- you typed the name of a game you owned and
/// the app told you nothing at all. Anything that moved to Epic, or never
/// shipped on Steam, was in the same position.
///
/// Asking both every time would be the obvious thing and is the wrong one: the
/// SteamGridDB path costs a search plus a thumbnail request per result, and
/// spending that on every keystroke for a game Steam already answered would
/// make the common case slow to fix the uncommon one.
#[tauri::command]
pub async fn search_games(
    term: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<Vec<SearchHit>, String> {
    let term = term.trim().to_string();
    if term.len() < 2 {
        return Ok(Vec::new());
    }

    let steam = search_steam(term.clone()).await?;
    if !steam.is_empty() {
        return Ok(steam);
    }

    let key = store
        .setting(crate::sgdb::SETTING_KEY)?
        .filter(|k| !k.is_empty());
    let Some(key) = key else {
        // Silence here is what made this feel broken. Steam has never heard of
        // the game, the one catalogue that might have is switched off, and
        // without saying so the app looks like it simply cannot search.
        log_warn!(
            "search",
            "{term:?} is not on Steam and no SteamGridDB key is set"
        );
        return Err(format!(
            "Steam has no game called {term:?} — it may be delisted or sold elsewhere. \
             Add a free SteamGridDB key in Settings to search there too."
        ));
    };

    let found = tauri::async_runtime::spawn_blocking(move || {
        let client = crate::meta::http_client().ok_or("no HTTP client")?;
        Ok::<_, String>(
            crate::sgdb::search(&client, &key, &term)
                .into_iter()
                .map(|e| SearchHit {
                    source: "sgdb",
                    app_id: e.id,
                    name: e.name,
                    thumbnail: e.cover,
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))??;

    log_info!(
        "search",
        "{} SteamGridDB results where Steam had none",
        found.len()
    );
    Ok(found)
}

/// The Steam half, on its own. Used by the artwork picker, which wants both
/// catalogues rather than one falling back to the other.
pub async fn search_steam_hits(term: String) -> Result<Vec<SearchHit>, String> {
    let term = term.trim().to_string();
    if term.len() < 2 {
        return Ok(Vec::new());
    }
    search_steam(term).await
}

/// Put `first` in front, then anything from `second` naming a different game.
///
/// Both catalogues list the same popular games, and a picker showing "Hollow
/// Knight" twice makes the person choosing wonder which one is the real one.
/// Names are compared loosely because the two sources punctuate differently --
/// Steam writes "Battlefield™ 6" where SteamGridDB writes "Battlefield 6", and
/// treating those as separate answers is the same duplicate with extra steps.
pub fn merge(first: Vec<SearchHit>, second: Vec<SearchHit>) -> Vec<SearchHit> {
    let mut seen: Vec<String> = first.iter().map(|h| loose(&h.name)).collect();
    let mut out = first;
    for hit in second {
        let key = loose(&hit.name);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(hit);
    }
    out
}

/// A name reduced to the letters and digits in it, lowercased.
fn loose(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

async fn search_steam(term: String) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!(
                "Marquee/",
                env!("CARGO_PKG_VERSION"),
                " (game launcher)"
            ))
            .build()
            .map_err(|e| e.to_string())?;

        let url = "https://store.steampowered.com/api/storesearch/";
        let response = client
            .get(url)
            .query(&[("term", term.as_str()), ("cc", "us"), ("l", "en")])
            .send()
            .map_err(|e| format!("search failed: {e}"))?;

        if response.status().as_u16() == 429 {
            return Err("Steam is rate limiting search. Try again in a moment.".into());
        }
        let body: serde_json::Value = response.json().map_err(|e| {
            log_warn!("search", "unreadable response: {e}");
            "Steam returned something unreadable".to_string()
        })?;

        Ok(hits_from(&body))
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(source: &'static str, id: &str, name: &str) -> SearchHit {
        SearchHit {
            source,
            app_id: id.into(),
            name: name.into(),
            thumbnail: String::new(),
        }
    }

    /// The two catalogues list the same popular games. A picker showing
    /// "Hollow Knight" twice makes the person choosing wonder which one is
    /// real, and picking the wrong one is not an error they can see.
    #[test]
    fn merge_drops_the_same_game_listed_twice() {
        let out = merge(
            vec![hit("sgdb", "1", "Hollow Knight")],
            vec![hit("steam", "367520", "Hollow Knight")],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "sgdb", "the first list wins");
    }

    /// Steam writes "Battlefield™ 6"; SteamGridDB writes "Battlefield 6".
    /// Comparing those strictly is the same duplicate with extra steps.
    #[test]
    fn merge_sees_through_punctuation_and_case() {
        for (a, b) in [
            ("Battlefield™ 6", "Battlefield 6"),
            ("HOLLOW KNIGHT", "Hollow Knight"),
            ("Marvel's Spider-Man", "Marvels Spider Man"),
            ("Rocket League®", "Rocket League"),
        ] {
            let out = merge(vec![hit("sgdb", "1", a)], vec![hit("steam", "2", b)]);
            assert_eq!(out.len(), 1, "{a:?} and {b:?} are the same game");
        }
    }

    #[test]
    fn merge_keeps_a_game_only_the_second_list_has() {
        let out = merge(
            vec![hit("sgdb", "1", "Rocket League")],
            vec![hit("steam", "2", "Rocket League Sideswipe")],
        );
        assert_eq!(out.len(), 2, "a different game must survive");
    }

    #[test]
    fn merge_preserves_the_order_within_each_list() {
        // Relevance order is the only ranking either catalogue gives us.
        let out = merge(
            vec![hit("sgdb", "1", "A"), hit("sgdb", "2", "B")],
            vec![hit("steam", "3", "C"), hit("steam", "4", "D")],
        );
        let names: Vec<&str> = out.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["A", "B", "C", "D"]);
    }

    #[test]
    fn merge_drops_a_nameless_entry_rather_than_deduping_on_nothing() {
        // Two entries with unnameable titles would otherwise collapse into
        // one, or worse, swallow a real result whose name reduced to empty.
        let out = merge(
            vec![hit("sgdb", "1", "Real")],
            vec![hit("steam", "2", "!!!")],
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn steam_hits_are_labelled_as_steam() {
        // The label decides whether the appid is treated as metadata-bearing.
        // Getting it wrong attaches another game's description and genres.
        let hits = hits_from(&serde_json::from_str(SAMPLE).unwrap());
        assert!(hits.iter().all(|h| h.source == "steam"));
    }

    /// Shape captured from the real endpoint.
    const SAMPLE: &str = r#"{
        "total": 2,
        "items": [
            {"type":"app","name":"Hollow Knight","id":367520,"tiny_image":"https://x/t.jpg"},
            {"type":"app","name":"Hollow Knight: Silksong","id":1030300}
        ]
    }"#;

    #[test]
    fn parses_results_and_keeps_the_thumbnail() {
        let hits = hits_from(&serde_json::from_str(SAMPLE).unwrap());
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].app_id, "367520");
        assert_eq!(hits[0].name, "Hollow Knight");
        // Steam's own thumbnail, used only if the artwork pipeline finds
        // nothing at all for the appid.
        assert_eq!(hits[0].thumbnail, "https://x/t.jpg");
    }

    /// Valve returns `{"total":0}` with no items key at all for a miss.
    #[test]
    fn a_response_with_no_items_is_empty_not_an_error() {
        assert!(hits_from(&serde_json::json!({"total": 0})).is_empty());
        assert!(hits_from(&serde_json::json!({})).is_empty());
        assert!(hits_from(&serde_json::json!({"items": "nonsense"})).is_empty());
    }

    #[test]
    fn entries_missing_a_name_or_id_are_skipped_not_fatal() {
        let body = serde_json::json!({"items": [
            {"name": "No id"},
            {"id": 5},
            {"name": "   ", "id": 6},
            {"name": "Good", "id": 7}
        ]});
        let hits = hits_from(&body);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Good");
    }
}

#[cfg(test)]
mod live {
    /// The bug this whole fallback exists for, checked against the real
    /// endpoints: Rocket League was delisted from Steam in 2020, so Steam's
    /// store index returns nothing for it and "Add a game" could not add a
    /// game the user owns. SteamGridDB has it.
    ///
    /// Needs a key in MARQUEE_SGDB_KEY.
    ///
    ///     MARQUEE_SGDB_KEY=... cargo test live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn a_delisted_game_is_findable_even_though_steam_has_no_page() {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("Marquee/test")
            .build()
            .unwrap();

        let steam: serde_json::Value = client
            .get("https://store.steampowered.com/api/storesearch/")
            .query(&[("term", "rocket league"), ("cc", "us"), ("l", "en")])
            .send()
            .expect("request")
            .json()
            .expect("json");
        let hits = super::hits_from(&steam);
        println!("steam: {} hits", hits.len());
        assert!(
            hits.is_empty(),
            "Steam now lists Rocket League; the premise of this test has changed"
        );

        let Ok(key) = std::env::var("MARQUEE_SGDB_KEY") else {
            println!("no MARQUEE_SGDB_KEY; skipping the half that needs one");
            return;
        };
        let found = crate::sgdb::search(&client, &key, "rocket league");
        println!(
            "sgdb: {:?}",
            found.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert!(
            found
                .iter()
                .any(|e| e.name.to_lowercase().starts_with("rocket league")),
            "SteamGridDB should have it"
        );
    }

    /// Hits the real endpoint. Ignored by default so the normal suite stays
    /// offline and deterministic, but run it whenever the parsing above is
    /// touched -- the golden tests prove we read the shape we captured, not
    /// that Valve still sends it.
    ///
    ///     cargo test live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn the_real_endpoint_still_answers() {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent("Marquee/test")
            .build()
            .unwrap();
        for term in ["hollow knight", "cyberpunk", "baldurs gate"] {
            let body: serde_json::Value = client
                .get("https://store.steampowered.com/api/storesearch/")
                .query(&[("term", term), ("cc", "us"), ("l", "en")])
                .send()
                .expect("request")
                .json()
                .expect("json");
            let hits = super::hits_from(&body);
            println!("{term:>16} -> {} hits", hits.len());
            for h in hits.iter().take(3) {
                println!("                   {:>8}  {}", h.app_id, h.name);
            }
            assert!(!hits.is_empty(), "no results for {term:?}");
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
    }
}
