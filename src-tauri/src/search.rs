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

use crate::log_warn;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub app_id: String,
    pub name: String,
    /// Portrait cover, the same asset the grid uses, so a result looks exactly
    /// like the card it will become.
    pub cover: String,
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
                        cover: format!(
                            "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/library_600x900.jpg"
                        ),
                        app_id,
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn search_games(term: String) -> Result<Vec<SearchHit>, String> {
    let term = term.trim().to_string();
    if term.len() < 2 {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("Marquee/", env!("CARGO_PKG_VERSION"), " (game launcher)"))
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

    /// Shape captured from the real endpoint.
    const SAMPLE: &str = r#"{
        "total": 2,
        "items": [
            {"type":"app","name":"Hollow Knight","id":367520,"tiny_image":"https://x/t.jpg"},
            {"type":"app","name":"Hollow Knight: Silksong","id":1030300}
        ]
    }"#;

    #[test]
    fn parses_results_and_builds_cover_urls() {
        let hits = hits_from(&serde_json::from_str(SAMPLE).unwrap());
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].app_id, "367520");
        assert_eq!(hits[0].name, "Hollow Knight");
        assert!(hits[0].cover.ends_with("/367520/library_600x900.jpg"));
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
