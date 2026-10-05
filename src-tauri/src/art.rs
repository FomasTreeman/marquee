//! Artwork: fetched once, resized on ingest to the displayed size, served from
//! disk through a custom protocol (never base64 in the DOM or bytes in the
//! database). See docs/PLAN.md §4. Once cached, the library works offline.

use std::io::Cursor;
use std::path::PathBuf;

use image::imageops::FilterType;

use serde::{Deserialize, Serialize};

use crate::{log_debug, log_if_err, log_info, log_warn, paths};

/// Longest edge in device pixels. A cover is 188 design px at up to 2×, so 480
/// is enough; the hero is full-bleed.
const COVER_MAX: u32 = 480;
const HERO_MAX: u32 = 1920;
const LOGO_MAX: u32 = 640;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Cover,
    Hero,
    Logo,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cover" => Kind::Cover,
            "hero" => Kind::Hero,
            "logo" => Kind::Logo,
            _ => return None,
        })
    }

    /// Every filename Steam publishes this asset under, best first. Steam is
    /// inconsistent about which exist (Rainbow Six Siege has only `portrait.png`).
    fn files(self) -> &'static [&'static str] {
        match self {
            Kind::Cover => &[
                "library_600x900.jpg",
                "portrait.png",
                "library_600x900_2x.jpg",
            ],
            Kind::Hero => &["library_hero.jpg", "library_hero_2x.jpg"],
            Kind::Logo => &["logo.png", "logo_2x.png"],
        }
    }

    /// The canonical name, for logging and cache keys.
    fn file(self) -> &'static str {
        self.files()[0]
    }

    fn want(self) -> crate::sgdb::Want {
        match self {
            Kind::Cover => crate::sgdb::Want::Grid,
            Kind::Hero => crate::sgdb::Want::Hero,
            Kind::Logo => crate::sgdb::Want::Logo,
        }
    }

    fn max_edge(self) -> u32 {
        match self {
            Kind::Cover => COVER_MAX,
            Kind::Hero => HERO_MAX,
            Kind::Logo => LOGO_MAX,
        }
    }

    /// The wordmark is transparent and stays PNG; photographs go to JPEG.
    fn keeps_alpha(self) -> bool {
        matches!(self, Kind::Logo)
    }

    fn extension(self) -> &'static str {
        if self.keeps_alpha() {
            "png"
        } else {
            "jpg"
        }
    }

    pub fn mime(self) -> &'static str {
        if self.keeps_alpha() {
            "image/png"
        } else {
            "image/jpeg"
        }
    }
}

/// Steam serves a flat grey placeholder with a 200 for missing assets, so
/// check pixel variance. File size is unreliable for genuinely small art.
fn is_placeholder(img: &image::DynamicImage) -> bool {
    let grey = img.to_luma8();
    let (w, h) = (grey.width(), grey.height());
    if w == 0 || h == 0 {
        return true;
    }
    let step_x = (w / 48).max(1);
    let step_y = (h / 48).max(1);
    let mut samples = Vec::new();
    for y in (0..h).step_by(step_y as usize) {
        for x in (0..w).step_by(step_x as usize) {
            samples.push(grey.get_pixel(x, y).0[0] as i32);
        }
    }
    if samples.is_empty() {
        return true;
    }
    let mean = samples.iter().sum::<i32>() / samples.len() as i32;
    let deviation = samples.iter().map(|s| (s - mean).abs()).sum::<i32>() / samples.len() as i32;
    // Steam's placeholder is near 0; real covers are in the tens.
    deviation < 8
}

/// A banner letterboxed or cropped into a 2:3 card looks broken, so reject
/// wrong-shaped art outright and let `compose_cover` build a portrait.
fn right_shape(kind: Kind, width: u32, height: u32) -> bool {
    if width == 0 || height == 0 {
        return false;
    }
    let ratio = width as f32 / height as f32;
    match kind {
        // Box art is 2:3; allow latitude, but never wider than tall.
        Kind::Cover => ratio < 0.95,
        Kind::Hero => ratio > 1.6,
        Kind::Logo => true,
    }
}

/// Crop away transparent margins. Steam wordmarks often sit in a large padded
/// canvas and would render tiny and off-centre.
fn trim_transparent(img: &image::DynamicImage) -> image::DynamicImage {
    use image::GenericImageView;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());

    // Low threshold so soft edges and glows count as ink.
    const INK: u8 = 8;
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            if rgba.get_pixel(x, y).0[3] > INK {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x1 < x0 || y1 < y0 {
        return img.clone(); // entirely transparent; nothing to trim to
    }
    img.view(x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image().into()
}

/// Bump when the pipeline's output changes, or stale cached art is served
/// before any new logic runs.
const ART_VERSION: u32 = 5;

/// Throw the artwork cache away if it was written by an older pipeline.
pub fn migrate_cache() {
    let dir = paths::cache_dir().join("art");
    let stamp = dir.join(".version");
    let current = std::fs::read_to_string(&stamp)
        .ok()
        .and_then(|t| t.trim().parse::<u32>().ok())
        .unwrap_or(1);
    if current >= ART_VERSION {
        return;
    }
    if dir.exists() {
        log_info!("art", "artwork pipeline changed; clearing the cache");
        log_if_err!(
            "art",
            std::fs::remove_dir_all(&dir),
            "clearing {}",
            dir.display()
        );
    }
    log_if_err!("art", paths::ensure(&dir), "cache dir {}", dir.display());
    // Without the stamp the cache is cleared again on every launch.
    log_if_err!(
        "art",
        std::fs::write(&stamp, ART_VERSION.to_string()),
        "stamping the cache version"
    );
}

fn path_for(slug: &str, kind: Kind) -> PathBuf {
    paths::cache_dir().join("art").join(format!(
        "{slug}-{}.{}",
        match kind {
            Kind::Cover => "cover",
            Kind::Hero => "hero",
            Kind::Logo => "logo",
        },
        kind.extension()
    ))
}

/// Build a portrait cover from blurred, darkened key art with the wordmark
/// centred. Needs a wordmark: an anonymous blur is worse than a text card.
fn compose_cover(hero: &image::DynamicImage, logo: &image::DynamicImage) -> image::DynamicImage {
    use image::imageops;

    const W: u32 = 600;
    const H: u32 = 900;

    // Fill, not fit: the background must reach every edge.
    let scale = (W as f32 / hero.width() as f32).max(H as f32 / hero.height() as f32);
    let filled = hero.resize(
        (hero.width() as f32 * scale).ceil() as u32,
        (hero.height() as f32 * scale).ceil() as u32,
        imageops::FilterType::Triangle,
    );
    let x = (filled.width().saturating_sub(W)) / 2;
    let y = (filled.height().saturating_sub(H)) / 2;
    let cropped = filled.crop_imm(x, y, W, H);

    // Blur small then enlarge; a gaussian at full size is slow.
    let small = cropped.resize_exact(60, 90, imageops::FilterType::Triangle);
    let blurred = image::imageops::blur(&small.to_rgba8(), 6.0);
    let mut canvas =
        image::DynamicImage::ImageRgba8(blurred).resize_exact(W, H, imageops::FilterType::Triangle);

    // Darkened, so a wordmark of any colour stays legible on top.
    {
        let buf = canvas.as_mut_rgba8().expect("rgba");
        for px in buf.pixels_mut() {
            px.0[0] = (px.0[0] as f32 * 0.42) as u8;
            px.0[1] = (px.0[1] as f32 * 0.42) as u8;
            px.0[2] = (px.0[2] as f32 * 0.42) as u8;
        }
    }

    {
        let logo = trim_transparent(logo);
        let max_w = (W as f32 * 0.76) as u32;
        let max_h = (H as f32 * 0.34) as u32;
        let fit = (max_w as f32 / logo.width() as f32).min(max_h as f32 / logo.height() as f32);
        let lw = ((logo.width() as f32 * fit) as u32).max(1);
        let lh = ((logo.height() as f32 * fit) as u32).max(1);
        let scaled = logo.resize_exact(lw, lh, imageops::FilterType::Lanczos3);
        imageops::overlay(
            &mut canvas,
            &scaled,
            ((W - lw) / 2) as i64,
            ((H - lh) / 2) as i64,
        );
    }

    canvas
}

/// Where each of a game's three assets came from, recorded so artwork
/// problems can be diagnosed without looking at the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Steam,
    SteamGridDb,
    /// Built here from key art plus a wordmark.
    Composed,
    /// Nothing usable exists at any source.
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// The cache key (`steam-1091500`, `sgdb-8452`), named `appId` on the wire
    /// for the interface.
    #[serde(rename = "appId")]
    pub slug: String,
    pub cover: Source,
    pub hero: Source,
    pub logo: Source,
    /// True when Steam alone supplied every field at the right shape.
    pub steam_complete: bool,
    pub version: u32,
}

fn manifest_path(slug: &str) -> PathBuf {
    paths::cache_dir()
        .join("art")
        .join(format!("{slug}-manifest.json"))
}

pub fn manifest(slug: &str) -> Option<Manifest> {
    let text = std::fs::read_to_string(manifest_path(slug)).ok()?;
    let m: Manifest = serde_json::from_str(&text).ok()?;
    if m.version < ART_VERSION {
        return None;
    }
    Some(m)
}

/// Download a URL and return it only if it is the right shape for `kind` and
/// not a placeholder. Neither a 200 nor a clean decode proves either.
fn usable(
    client: &reqwest::blocking::Client,
    url: &str,
    kind: Kind,
) -> Option<(bytes::Bytes, image::DynamicImage)> {
    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    // Shape first: it is far cheaper than the placeholder scan.
    if !right_shape(kind, img.width(), img.height()) {
        log_debug!(
            "art",
            "{url}: {}x{} wrong shape for {kind:?}",
            img.width(),
            img.height()
        );
        return None;
    }
    if is_placeholder(&img) {
        log_debug!("art", "{url}: placeholder");
        return None;
    }
    Some((bytes, img))
}

fn steam_urls(app_id: &str, kind: Kind) -> Vec<String> {
    kind.files()
        .iter()
        .map(|f| format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/{f}"))
        .collect()
}

/// Which catalogue a game's artwork is looked up in, so the picker can point a
/// game at SteamGridDB when Steam's artwork is the missing one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKey {
    Steam(String),
    SteamGridDb(u64),
}

impl SourceKey {
    /// Parses `steam-1091500` or `sgdb-8452` from art:// URLs. Ids must be
    /// digits, so they can never carry a slash or dot into a cache path.
    pub fn parse(s: &str) -> Option<Self> {
        let (prefix, id) = s.split_once('-')?;
        if id.is_empty() || id.len() > 12 || !id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        match prefix {
            "steam" => Some(SourceKey::Steam(id.to_string())),
            "sgdb" => Some(SourceKey::SteamGridDb(id.parse().ok()?)),
            _ => None,
        }
    }

    /// Cache filename stem, distinct per source so re-pointed art cannot collide.
    fn slug(&self) -> String {
        match self {
            SourceKey::Steam(id) => format!("steam-{id}"),
            SourceKey::SteamGridDb(id) => format!("sgdb-{id}"),
        }
    }
}

const KINDS: [Kind; 3] = [Kind::Cover, Kind::Hero, Kind::Logo];

/// Resolve all three assets for a game and record where each came from.
fn resolve(key: &SourceKey, sgdb_key: Option<&str>) -> Manifest {
    let slug = key.slug();
    let mut m = Manifest {
        slug: slug.clone(),
        cover: Source::None,
        hero: Source::None,
        logo: Source::None,
        steam_complete: false,
        version: ART_VERSION,
    };
    let Some(client) = crate::meta::http_client() else {
        return m;
    };
    let sgdb_key = sgdb_key.filter(|k| !k.is_empty());

    let mut found: Vec<(Kind, bytes::Bytes, image::DynamicImage, Source)> = Vec::new();

    match key {
        SourceKey::SteamGridDb(game_id) => {
            if let Some(k) = sgdb_key {
                for kind in KINDS {
                    for url in crate::sgdb::candidates_for_game(&client, k, *game_id, kind.want()) {
                        if let Some((b, i)) = usable(&client, &url, kind) {
                            found.push((kind, b, i, Source::SteamGridDb));
                            break;
                        }
                    }
                }
            }
        }

        SourceKey::Steam(app_id) => {
            for kind in KINDS {
                for url in steam_urls(app_id, kind) {
                    if let Some((b, i)) = usable(&client, &url, kind) {
                        found.push((kind, b, i, Source::Steam));
                        break;
                    }
                }
            }
            m.steam_complete = found.len() == KINDS.len();

            // If Steam's set is incomplete, prefer a full SteamGridDB set so a
            // card does not mix two artists' work.
            if !m.steam_complete {
                if let Some(k) = sgdb_key {
                    let mut replacements = Vec::new();
                    for kind in KINDS {
                        for url in
                            crate::sgdb::candidates_for_steam_app(&client, k, app_id, kind.want())
                        {
                            if let Some((b, i)) = usable(&client, &url, kind) {
                                replacements.push((kind, b, i, Source::SteamGridDb));
                                break;
                            }
                        }
                    }
                    if replacements.len() == KINDS.len() {
                        found = replacements;
                    } else {
                        for (kind, b, i, s) in replacements {
                            if !found.iter().any(|(k, ..)| *k == kind) {
                                found.push((kind, b, i, s));
                            }
                        }
                    }
                }
            }

            // A hero may fall back to the wide store capsule, which is the same
            // shape. A cover never does; it is composed instead.
            if !found.iter().any(|(k, ..)| *k == Kind::Hero) {
                let mut capsules = Vec::new();
                if let crate::meta::Fetched::Found(meta) = crate::meta::fetch_one(&client, app_id) {
                    if !meta.header_image.is_empty() {
                        capsules.push(meta.header_image);
                    }
                }
                capsules.push(format!(
                    "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/header.jpg"
                ));
                for url in capsules {
                    if let Some((b, i)) = usable(&client, &url, Kind::Hero) {
                        found.push((Kind::Hero, b, i, Source::Steam));
                        break;
                    }
                }
            }
        }
    }

    let mut have: std::collections::HashMap<Kind, image::DynamicImage> = Default::default();
    for (kind, raw, img, source) in found {
        // Reuse the decode from `usable`; decoding is the expensive step.
        let encoded = if kind == Kind::Logo {
            let trimmed = trim_transparent(&img);
            let capped = downscale(&trimmed, kind).unwrap_or(trimmed);
            encode(&capped, kind)
        } else {
            shrink(&img, kind).unwrap_or_else(|| Ok(raw.to_vec()))
        }
        .unwrap_or_else(|e| {
            log_warn!(
                "art",
                "{slug}: re-encoding {} failed, caching the original: {e}",
                kind.file()
            );
            raw.to_vec()
        });
        write_cached(&path_for(&slug, kind), &encoded);
        have.insert(kind, img);
        match kind {
            Kind::Cover => m.cover = source,
            Kind::Hero => m.hero = source,
            Kind::Logo => m.logo = source,
        }
    }

    if m.cover == Source::None {
        if let (Some(hero), Some(logo)) = (have.get(&Kind::Hero), have.get(&Kind::Logo)) {
            let composed = compose_cover(hero, logo);
            let mut out = std::io::Cursor::new(Vec::new());
            if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)
                .encode_image(&composed.to_rgb8())
                .is_ok()
            {
                write_cached(&path_for(&slug, Kind::Cover), &out.into_inner());
                m.cover = Source::Composed;
            }
        }
    }

    for (kind, source) in [
        (Kind::Cover, m.cover),
        (Kind::Hero, m.hero),
        (Kind::Logo, m.logo),
    ] {
        if source == Source::None {
            log_debug!("art", "{slug}: no source has a usable {}", kind.file());
            write_cached(&path_for(&slug, kind), b"");
        }
    }

    if let Ok(text) = serde_json::to_string(&m) {
        write_cached(&manifest_path(&slug), text.as_bytes());
    }
    log_info!(
        "art",
        "{slug}: cover={:?} hero={:?} logo={:?}{}",
        m.cover,
        m.hero,
        m.logo,
        if m.steam_complete {
            " (steam complete)"
        } else {
            ""
        }
    );
    m
}

/// One resolution per game at a time, or the cover and hero requests both
/// download everything. Per game so unrelated games still run in parallel.
static IN_FLIGHT: std::sync::Mutex<
    Option<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>,
> = std::sync::Mutex::new(None);

fn lock_for(slug: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    let mut map = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    map.get_or_insert_with(Default::default)
        .entry(slug.to_string())
        .or_default()
        .clone()
}

/// Games known to have a current manifest on disk, so a scroll does not
/// re-read and parse it for every request.
static RESOLVED: std::sync::RwLock<Option<std::collections::HashSet<String>>> =
    std::sync::RwLock::new(None);

fn is_resolved(slug: &str) -> bool {
    let known = RESOLVED.read().unwrap_or_else(|e| e.into_inner());
    if known.as_ref().is_some_and(|s| s.contains(slug)) {
        return true;
    }
    drop(known);
    if manifest(slug).is_some() {
        mark_resolved(slug);
        return true;
    }
    false
}

fn mark_resolved(slug: &str) {
    RESOLVED
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .insert(slug.to_string());
}

pub fn fetch(key: &SourceKey, kind: Kind, sgdb_key: Option<&str>) -> Option<Vec<u8>> {
    let slug = key.slug();
    let path = path_for(&slug, kind);

    if !is_resolved(&slug) {
        let gate = lock_for(&slug);
        let _held = gate.lock().unwrap_or_else(|e| e.into_inner());
        // Whoever held the lock may have just done the work.
        if !is_resolved(&slug) {
            resolve(key, sgdb_key);
            // Even if the manifest write failed, or every request re-downloads.
            mark_resolved(&slug);
        }
    }
    match std::fs::read(&path) {
        Ok(bytes) if !bytes.is_empty() => Some(bytes),
        _ => None,
    }
}

/// What the pipeline decided for a game, for the interface and the log.
#[tauri::command]
pub fn artwork_report(app_ids: Vec<String>) -> Vec<Manifest> {
    app_ids.iter().filter_map(|id| manifest(id)).collect()
}

/// Temp-then-rename, so a half-written file is never read as cached or as a
/// zero-byte miss.
fn write_cached(path: &std::path::Path, bytes: &[u8]) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if let Some(dir) = path.parent() {
        log_if_err!("art", paths::ensure(dir), "cache dir {}", dir.display());
    }
    let tmp = path.with_extension("tmp");
    match std::fs::write(&tmp, bytes) {
        Ok(()) => log_if_err!("art", std::fs::rename(&tmp, path), "caching {name}"),
        Err(e) => log_warn!("art", "caching {name}: {e}"),
    }
}

/// Scale down to the cap, or None if already small enough.
fn downscale(img: &image::DynamicImage, kind: Kind) -> Option<image::DynamicImage> {
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= kind.max_edge() {
        return None;
    }
    let scale = kind.max_edge() as f32 / w.max(h) as f32;
    // Lanczos3 is slower but runs once per asset, off the UI thread.
    Some(img.resize(
        (w as f32 * scale) as u32,
        (h as f32 * scale) as u32,
        FilterType::Lanczos3,
    ))
}

/// Throw away every cached image and recorded miss, so adding a SteamGridDB
/// key re-resolves games that previously found nothing.
pub fn clear_cache() -> std::io::Result<()> {
    let dir = paths::cache_dir().join("art");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    paths::ensure(&dir)?;
    std::fs::write(dir.join(".version"), ART_VERSION.to_string())?;
    // Or misses keep answering from memory after the disk is wiped.
    *RESOLVED.write().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

/// Re-encoded bytes for an asset over its cap, or None to store the original.
/// Never upscale, and never re-encode when no resize is needed (a second
/// generation of JPEG loss).
fn shrink(img: &image::DynamicImage, kind: Kind) -> Option<image::ImageResult<Vec<u8>>> {
    Some(encode(&downscale(img, kind)?, kind))
}

fn encode(img: &image::DynamicImage, kind: Kind) -> image::ImageResult<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    if kind.keeps_alpha() {
        img.write_to(&mut out, image::ImageFormat::Png)?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)
            .encode_image(&img.to_rgb8())?;
    }
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> image::DynamicImage {
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 255) as u8, (y % 255) as u8, 128, 255])
        }))
    }

    #[test]
    fn a_large_cover_is_scaled_down() {
        let out = shrink(&gradient(600, 900), Kind::Cover).unwrap().unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!(img.height(), COVER_MAX, "longest edge should hit the cap");
        assert_eq!(img.width(), 320);
        // Pixel count, not byte size: it drives decode cost and memory, and
        // byte size depends on content.
        assert!(
            img.width() * img.height() < 600 * 900 / 3,
            "should be well under a third of the pixels"
        );
    }

    #[test]
    fn a_small_asset_is_left_completely_alone() {
        assert!(shrink(&gradient(120, 180), Kind::Cover).is_none());
        assert!(shrink(&gradient(300, 450), Kind::Cover).is_none());
        assert!(shrink(&gradient(320, COVER_MAX), Kind::Cover).is_none());
    }

    #[test]
    fn the_wordmark_keeps_its_alpha() {
        let out = shrink(&gradient(1800, 600), Kind::Logo).unwrap().unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert!(img.color().has_alpha(), "logo must stay PNG with alpha");
        assert_eq!(Kind::Logo.mime(), "image/png");
        assert_eq!(Kind::Cover.mime(), "image/jpeg");
    }

    #[test]
    fn a_flat_image_is_recognised_as_a_placeholder() {
        let flat = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            300,
            450,
            image::Luma([128]),
        ));
        assert!(is_placeholder(&flat));

        // Slight noise, as JPEG compression of a grey box gives.
        let dithered =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_fn(300, 450, |x, y| {
                image::Luma([128 + ((x + y) % 3) as u8])
            }));
        assert!(is_placeholder(&dithered));
    }

    #[test]
    fn real_artwork_is_not_mistaken_for_a_placeholder() {
        let art = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(300, 450, |x, y| {
            let v = if (x / 20 + y / 20) % 2 == 0 { 20 } else { 230 };
            image::Rgba([v, v, v, 255])
        }));
        assert!(!is_placeholder(&art));

        // Low contrast, but not uniform.
        let gradient =
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(300, 450, |_, y| {
                let v = (y * 255 / 450) as u8;
                image::Rgba([v, v, v, 255])
            }));
        assert!(!is_placeholder(&gradient));
    }

    #[test]
    fn a_degenerate_image_is_treated_as_a_placeholder() {
        let one =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(1, 1, image::Luma([0])));
        assert!(is_placeholder(&one));
    }

    #[test]
    fn clearing_the_cache_forgets_what_was_resolved() {
        mark_resolved("steam-forgotten");
        assert!(is_resolved("steam-forgotten"));
        clear_cache().unwrap();
        assert!(!is_resolved("steam-forgotten"));
    }

    #[test]
    fn a_banner_is_never_accepted_as_a_cover() {
        assert!(!right_shape(Kind::Cover, 460, 215));
        assert!(!right_shape(Kind::Cover, 1920, 620));
        assert!(!right_shape(Kind::Cover, 512, 512), "square is not box art");
        assert!(right_shape(Kind::Cover, 600, 900));
        assert!(right_shape(Kind::Cover, 300, 450));
    }

    #[test]
    fn a_portrait_image_is_never_accepted_as_a_hero() {
        assert!(!right_shape(Kind::Hero, 600, 900));
        assert!(right_shape(Kind::Hero, 1920, 620));
        // A wordmark is any shape at all.
        assert!(right_shape(Kind::Logo, 10, 400));
    }

    #[test]
    fn a_wordmark_is_trimmed_to_its_ink() {
        let padded =
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(1000, 800, |x, y| {
                let inside = (400..600).contains(&x) && (300..500).contains(&y);
                image::Rgba([255, 255, 255, if inside { 255 } else { 0 }])
            }));
        let trimmed = trim_transparent(&padded);
        assert_eq!((trimmed.width(), trimmed.height()), (200, 200));
    }

    #[test]
    fn faint_edges_survive_trimming() {
        let glow = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(100, 100, |x, y| {
            let core = (40..60).contains(&x) && (40..60).contains(&y);
            let halo = (30..70).contains(&x) && (30..70).contains(&y);
            image::Rgba([
                255,
                255,
                255,
                if core {
                    255
                } else if halo {
                    40
                } else {
                    0
                },
            ])
        }));
        let trimmed = trim_transparent(&glow);
        assert_eq!(
            (trimmed.width(), trimmed.height()),
            (40, 40),
            "halo should survive"
        );
    }

    #[test]
    fn an_entirely_transparent_image_is_left_alone() {
        let blank = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            50,
            50,
            image::Rgba([0, 0, 0, 0]),
        ));
        assert_eq!(trim_transparent(&blank).width(), 50);
    }

    #[test]
    fn a_cover_is_composed_at_the_right_shape() {
        let hero = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(1920, 620, |x, _| {
            image::Rgba([(x % 255) as u8, 90, 160, 255])
        }));
        let logo = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(800, 200, |x, y| {
            let ink = (100..700).contains(&x) && (50..150).contains(&y);
            image::Rgba([255, 255, 255, if ink { 255 } else { 0 }])
        }));

        let composed = compose_cover(&hero, &logo);
        assert_eq!((composed.width(), composed.height()), (600, 900));
        assert!(right_shape(
            Kind::Cover,
            composed.width(),
            composed.height()
        ));
        // The wordmark alone guarantees variation.
        assert!(!is_placeholder(&composed));
    }

    #[test]
    fn every_kind_has_more_than_one_name_to_try() {
        for kind in [Kind::Cover, Kind::Hero, Kind::Logo] {
            assert!(kind.files().len() > 1, "{kind:?} should have alternatives");
            assert_eq!(kind.file(), kind.files()[0], "canonical name is the first");
        }
        // Rainbow Six Siege has only the png.
        assert!(Kind::Cover.files().contains(&"portrait.png"));
    }

    #[test]
    fn a_source_key_round_trips_and_rejects_rubbish() {
        assert_eq!(
            SourceKey::parse("steam-1091500"),
            Some(SourceKey::Steam("1091500".into()))
        );
        assert_eq!(
            SourceKey::parse("sgdb-8452"),
            Some(SourceKey::SteamGridDb(8452))
        );
        assert_eq!(
            SourceKey::parse("steam-1091500").unwrap().slug(),
            "steam-1091500"
        );

        for bad in [
            "",
            "1091500",
            "steam-",
            "steam-abc",
            "steam-../etc",
            "gog-123",
            "steam-12.34",
            "steam-1234567890123",
            "sgdb-x",
        ] {
            assert!(
                SourceKey::parse(bad).is_none(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn each_source_gets_its_own_cache_slot() {
        let a = SourceKey::Steam("440".into()).slug();
        let b = SourceKey::SteamGridDb(440).slug();
        assert_ne!(a, b);
    }

    #[test]
    fn kinds_round_trip_through_their_url_names() {
        for (name, kind) in [
            ("cover", Kind::Cover),
            ("hero", Kind::Hero),
            ("logo", Kind::Logo),
        ] {
            assert_eq!(Kind::parse(name), Some(kind));
        }
        assert_eq!(Kind::parse("../../etc/passwd"), None);
        assert_eq!(Kind::parse(""), None);
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Prints the resolution report for real games. Battlefield 6 exercises
    /// every fallback: its cover and logo are grey placeholders.
    ///
    ///     cargo test live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn resolution_report() {
        let _ = clear_cache();
        for (app_id, name) in [
            ("440", "Team Fortress 2"),
            ("620", "Portal 2"),
            ("2807960", "Battlefield 6"),
            ("377560", "Rainbow Six Siege"),
            ("1091500", "Cyberpunk 2077"),
        ] {
            let m = super::resolve(&SourceKey::Steam(app_id.to_string()), None);
            println!(
                "  {:<22} cover={:<12?} hero={:<12?} logo={:<12?} steam_complete={}",
                name, m.cover, m.hero, m.logo, m.steam_complete
            );
        }
    }

    #[test]
    #[ignore]
    fn a_recent_release_still_gets_artwork() {
        let dir = paths::cache_dir().join("art");
        let _ = std::fs::remove_dir_all(&dir);

        for (kind, must_have) in [(Kind::Cover, true), (Kind::Hero, true), (Kind::Logo, false)] {
            let got = fetch(&SourceKey::Steam("2807960".into()), kind, None);
            match &got {
                Some(bytes) => {
                    let img = image::load_from_memory(bytes).expect("decodable");
                    println!(
                        "  {:?}: {} KB, {}x{}",
                        kind,
                        bytes.len() / 1024,
                        img.width(),
                        img.height()
                    );
                    assert!(!is_placeholder(&img), "{kind:?} came back as a placeholder");
                }
                None => println!("  {kind:?}: none"),
            }
            if must_have {
                assert!(got.is_some(), "{kind:?} should have resolved to something");
            }
        }
    }
}

#[cfg(test)]
mod compose_preview {
    /// Writes composed covers from real games to temp for a human to inspect.
    ///
    ///     cargo test compose_preview -- --ignored --nocapture
    #[test]
    #[ignore]
    fn preview() {
        let client = crate::meta::http_client().unwrap();
        for (app_id, name) in [("440", "team-fortress-2"), ("620", "portal-2")] {
            let get = |file: &str| {
                client
                    .get(format!(
                        "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/{file}"
                    ))
                    .send()
                    .ok()
                    .and_then(|r| r.bytes().ok())
                    .and_then(|b| image::load_from_memory(&b).ok())
            };
            let (Some(hero), Some(logo)) = (get("library_hero.jpg"), get("logo.png")) else {
                println!("  {name}: missing source art");
                continue;
            };
            let composed = super::compose_cover(&hero, &logo);
            let out = std::env::temp_dir().join(format!("marquee-composed-{name}.jpg"));
            composed.to_rgb8().save(&out).unwrap();
            println!("  {name}: {}", out.display());
        }
    }
}
