//! Finding a game by name for the add-game flow (docs/PLAN.md §5).
//!
//! Steam's keyless store search covers most PC games whoever sold them, so a
//! GOG or Epic copy is identified here and borrows Steam's artwork by appid.

use serde::Serialize;

use crate::{log_info, log_warn};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub app_id: String,
    pub name: String,
    /// `steam` or `sgdb`. Only a Steam appid unlocks metadata; a SteamGridDB
    /// hit carries artwork alone, so the interface adds them differently.
    pub source: &'static str,
    /// Fallback only; the interface builds the cover from the appid through the
    /// normal artwork pipeline so a result matches the card it becomes.
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

/// Find a game by name: Steam first, since its appid carries metadata, then
/// SteamGridDB only if Steam has nothing. Steam's index omits delisted games
/// (Rocket League), and asking SteamGridDB every keystroke is too slow.
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
        // Say why, or the app looks like it simply cannot search.
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

/// Steam only, for the artwork picker, which merges both catalogues itself.
pub async fn search_steam_hits(term: String) -> Result<Vec<SearchHit>, String> {
    let term = term.trim().to_string();
    if term.len() < 2 {
        return Ok(Vec::new());
    }
    search_steam(term).await
}

/// `first`, then games from `second` it does not already list, with an exact
/// match for `term` moved to the front. Names compare loosely because Steam
/// writes "Battlefield™ 6" where SteamGridDB writes "Battlefield 6".
pub fn merge(term: &str, first: Vec<SearchHit>, second: Vec<SearchHit>) -> Vec<SearchHit> {
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
    rank(term, out)
}

/// Move an exact (loose) match for `term` to the front, stable otherwise.
/// SteamGridDB's community ranking can bury the exact title behind fan packs.
pub fn rank(term: &str, hits: Vec<SearchHit>) -> Vec<SearchHit> {
    let target = loose(term);
    let mut hits = hits;
    if !target.is_empty() {
        hits.sort_by_key(|h| loose(&h.name) != target);
    }
    hits
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
        // Shorter than the default timeout; this is behind a search box.
        let client = crate::meta::http_client_with(std::time::Duration::from_secs(10))
            .ok_or("no HTTP client")?;

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

    #[test]
    fn merge_drops_the_same_game_listed_twice() {
        let out = merge(
            "Hollow Knight",
            vec![hit("sgdb", "1", "Hollow Knight")],
            vec![hit("steam", "367520", "Hollow Knight")],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "sgdb", "the first list wins");
    }

    #[test]
    fn merge_sees_through_punctuation_and_case() {
        for (a, b) in [
            ("Battlefield™ 6", "Battlefield 6"),
            ("HOLLOW KNIGHT", "Hollow Knight"),
            ("Marvel's Spider-Man", "Marvels Spider Man"),
            ("Rocket League®", "Rocket League"),
        ] {
            let out = merge(a, vec![hit("sgdb", "1", a)], vec![hit("steam", "2", b)]);
            assert_eq!(out.len(), 1, "{a:?} and {b:?} are the same game");
        }
    }

    #[test]
    fn merge_keeps_a_game_only_the_second_list_has() {
        let out = merge(
            "Rocket League",
            vec![hit("sgdb", "1", "Rocket League")],
            vec![hit("steam", "2", "Rocket League Sideswipe")],
        );
        assert_eq!(out.len(), 2, "a different game must survive");
    }

    #[test]
    fn merge_preserves_the_order_within_each_list() {
        let out = merge(
            "does not match any of these",
            vec![hit("sgdb", "1", "A"), hit("sgdb", "2", "B")],
            vec![hit("steam", "3", "C"), hit("steam", "4", "D")],
        );
        let names: Vec<&str> = out.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["A", "B", "C", "D"]);
    }

    #[test]
    fn merge_puts_an_exact_match_first_however_low_its_catalogue_ranked_it() {
        let out = merge(
            "WARDOGS",
            vec![
                hit("sgdb", "1", "War Dogs Redux Pack"),
                hit("sgdb", "2", "Wardogs (Unofficial)"),
                hit("sgdb", "3", "WAR DOGS Fan Edition"),
            ],
            vec![
                hit("steam", "4", "War Dogs: The Board Game"),
                hit("steam", "5", "WARDOGS"),
            ],
        );
        assert_eq!(out[0].name, "WARDOGS");
        assert_eq!(out[0].app_id, "5");
    }

    #[test]
    fn an_exact_match_is_found_loosely_too() {
        let out = merge(
            "Battlefield 6",
            vec![hit("sgdb", "1", "Battlefield 6 Concept Art")],
            vec![hit("steam", "2", "Battlefield™ 6")],
        );
        assert_eq!(out[0].name, "Battlefield™ 6");
    }

    #[test]
    fn no_exact_match_leaves_the_order_untouched() {
        let out = rank(
            "Wardogs",
            vec![
                hit("sgdb", "1", "War Dogs Redux"),
                hit("steam", "2", "War Dogs 2"),
            ],
        );
        let names: Vec<&str> = out.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["War Dogs Redux", "War Dogs 2"]);
    }

    #[test]
    fn merge_drops_a_nameless_entry_rather_than_deduping_on_nothing() {
        let out = merge(
            "Real",
            vec![hit("sgdb", "1", "Real")],
            vec![hit("steam", "2", "!!!")],
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn steam_hits_are_labelled_as_steam() {
        // A wrong label would attach another game's metadata to the appid.
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
    /// Rocket League is delisted from Steam but on SteamGridDB.
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

    /// Run when touching the parser: the golden tests only prove we read the
    /// captured shape, not that Valve still sends it.
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
