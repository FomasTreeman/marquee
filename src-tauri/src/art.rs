//! Artwork: fetched once, resized on ingest, served from disk.
//!
//! docs/PLAN.md §4 is blunt about this being the whole performance story. Two
//! thousand covers at 600×900 is roughly 200 MB of decoded bitmap if handled
//! carelessly, and the rules that avoid it are:
//!
//!   * **Resize on ingest**, to the size actually displayed, never at paint.
//!   * **Serve through a custom protocol**, never base64 into the DOM and
//!     never image bytes in the database.
//!
//! It also buys the thing a launcher on a television needs more than speed:
//! **it works offline.** After the first pass the library renders with no
//! network at all, so a Steam CDN outage or a dropped connection is invisible.

use std::io::Cursor;
use std::path::PathBuf;

use image::imageops::FilterType;

use serde::{Deserialize, Serialize};

use crate::{log_debug, log_if_err, log_info, log_warn, paths};

/// Longest edge, in device pixels, for each kind.
///
/// A cover is 188 design px wide and the design scales up to 2×, so 480 covers
/// a HiDPI television with room to spare while being a quarter the pixels of
/// the 600×900 original. The hero is full-bleed, so it keeps real width.
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

    /// Every filename Steam publishes this asset under, best first.
    ///
    /// More than one, because Steam is inconsistent about which it has.
    /// Rainbow Six Siege 404s on `library_600x900.jpg` and serves a perfect
    /// 600x900 `portrait.png`; Battlefield 6 has both and both are grey
    /// placeholders. Trying one name and giving up was leaving real artwork on
    /// the table.
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

    /// The wordmark is transparent and must stay PNG. Photographs re-encode to
    /// JPEG, which is a quarter the size for no visible difference at these
    /// dimensions.
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

/// Steam serves a flat grey placeholder rather than a 404 when an asset does
/// not exist, and it does this for a lot of recent releases -- Battlefield 6's
/// `library_600x900.jpg` is 1.6 KB of grey, while its `library_hero.jpg` is
/// 250 KB of real art. A 200 is therefore not evidence of anything.
///
/// Detected by content rather than by size, because a size threshold is a guess
/// that fails on genuinely small artwork. A placeholder is near-uniform; real
/// cover art is not, by an enormous margin.
fn is_placeholder(img: &image::DynamicImage) -> bool {
    let grey = img.to_luma8();
    let (w, h) = (grey.width(), grey.height());
    if w == 0 || h == 0 {
        return true;
    }
    // Sample a grid rather than every pixel: a few thousand points settle this
    // question and the full decode is the expensive part anyway.
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
    // Real artwork sits far above this. Measured: Steam's placeholder is
    // effectively 0, Team Fortress 2's cover is in the high tens.
    deviation < 8
}

/// Is this the right shape for the slot it is going into?
///
/// A cover is portrait and a hero is wide, and neither substitutes for the
/// other. A banner letterboxed into a 2:3 card looks broken -- which it did --
/// and cropping one to portrait gives a narrow vertical slice of the middle.
/// So a wrong-shaped asset is rejected outright, and §compose_cover builds a
/// real portrait image instead.
fn right_shape(kind: Kind, width: u32, height: u32) -> bool {
    if width == 0 || height == 0 {
        return false;
    }
    let ratio = width as f32 / height as f32;
    match kind {
        // Real box art is 2:3. Allow some latitude either side, but never
        // anything wider than it is tall.
        Kind::Cover => ratio < 0.95,
        Kind::Hero => ratio > 1.6,
        Kind::Logo => true,
    }
}

/// Crop away fully transparent margins.
///
/// Steam's wordmarks are frequently a small logo inside a large transparent
/// canvas -- Rainbow Six Siege's has so much padding that the artwork renders
/// tiny and visibly off-centre inside its own box. Trimming to the ink makes
/// every wordmark fill the space it is given, which is what the hero layout
/// assumes.
fn trim_transparent(img: &image::DynamicImage) -> image::DynamicImage {
    use image::GenericImageView;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());

    // Not fully-opaque: soft edges and drop shadows are part of the artwork,
    // and trimming to them would clip the glow off a wordmark.
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

/// Bumped when the pipeline's *output* changes, not merely its code.
///
/// Cached art written before banners were rejected is a banner sitting in a
/// card, and no amount of new logic reaches it -- the cache answers first. The
/// metadata cache learned this lesson one release earlier; this is the same
/// lesson applied before it bites rather than after.
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
    // Without the stamp the cache reads as version 1 and is cleared again next
    // launch, so every start re-downloads everything and nothing says why.
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

/// Fetch, resize and store. Returns the bytes ready to serve.
/// Build a portrait cover out of a game's other artwork.
///
/// Some games publish no box art anywhere: not on Steam, not on SteamGridDB.
/// The previous answer was to letterbox the wide capsule into the card, which
/// looked exactly as broken as it sounds. Every card should carry a real
/// portrait image, so when none exists, one is made.
///
/// A heavily blurred, darkened fill of the game's own key art, with its
/// wordmark centred on top. It reads as deliberate rather than as a fallback,
/// and it is built from the game's own colours so it sits correctly beside
/// real covers.
///
/// **A wordmark is required.** Composing without one produces a handsome
/// abstract blur that identifies nothing -- which is worse than the plain
/// tinted card carrying the game's name in text, because a launcher's job is
/// letting you find a game at a glance. So when there is no wordmark, this is
/// not used and the card falls back to type.
fn compose_cover(hero: &image::DynamicImage, logo: &image::DynamicImage) -> image::DynamicImage {
    use image::imageops;

    const W: u32 = 600;
    const H: u32 = 900;

    // Fill, not fit: the background must reach every edge, and it is about to
    // be blurred past recognition anyway.
    let scale = (W as f32 / hero.width() as f32).max(H as f32 / hero.height() as f32);
    let filled = hero.resize(
        (hero.width() as f32 * scale).ceil() as u32,
        (hero.height() as f32 * scale).ceil() as u32,
        imageops::FilterType::Triangle,
    );
    let x = (filled.width().saturating_sub(W)) / 2;
    let y = (filled.height().saturating_sub(H)) / 2;
    let cropped = filled.crop_imm(x, y, W, H);

    // Blurred at a small size and then enlarged: a gaussian over 600x900 is
    // slow, and the result is indistinguishable once it is this soft.
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
        // Bounded on both axes so a very wide or very tall wordmark still fits
        // inside the card with margin.
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

/// Where each of a game's three assets came from.
///
/// Recorded rather than inferred. "Is the artwork working" was previously only
/// answerable by looking at the screen; now every game carries a manifest
/// saying what was tried, what was rejected and why.
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
    pub app_id: String,
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

/// Download a URL and return it only if it is genuinely usable for `kind`.
///
/// Both halves matter. A 200 means nothing -- Steam answers with a flat grey
/// placeholder rather than a 404 -- and neither does a decodable image, because
/// a banner decodes perfectly and is still not box art.
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
    if is_placeholder(&img) {
        log_debug!("art", "{url}: placeholder");
        return None;
    }
    if !right_shape(kind, img.width(), img.height()) {
        log_debug!(
            "art",
            "{url}: {}x{} wrong shape for {kind:?}",
            img.width(),
            img.height()
        );
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

/// Which catalogue a game's artwork is being looked up in.
///
/// Previously everything was keyed by Steam appid, which meant the artwork
/// picker could only ever re-point a game at a *different Steam game* -- no
/// help at all when the missing artwork is Steam's. A SteamGridDB entry is now
/// addressable directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKey {
    Steam(String),
    SteamGridDb(u64),
}

impl SourceKey {
    /// Parses `steam-1091500` or `sgdb-8452`, the form used in art:// URLs.
    ///
    /// Ids reach this from files on disk and from a database, so they are
    /// validated as digits rather than trusted -- a path segment that cannot
    /// contain a slash or a dot cannot traverse anywhere.
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

    /// Cache filename stem. Distinct per source, so re-pointing a game's
    /// artwork cannot collide with the original.
    fn slug(&self) -> String {
        match self {
            SourceKey::Steam(id) => format!("steam-{id}"),
            SourceKey::SteamGridDb(id) => format!("sgdb-{id}"),
        }
    }
}

const KINDS: [Kind; 3] = [Kind::Cover, Kind::Hero, Kind::Logo];

/// Resolve all three assets for a game, and record where each came from.
///
/// Deliberately per-game rather than per-request. Steam is tried first for
/// everything; only if it cannot supply the complete set does SteamGridDB get
/// asked, and then it is asked for **every** field rather than just the missing
/// ones -- a Steam cover beside a SteamGridDB wordmark is two artists' work in
/// one card, and it shows.
fn resolve(key: &SourceKey, sgdb_key: Option<&str>) -> Manifest {
    let slug = key.slug();
    let mut m = Manifest {
        app_id: slug.clone(),
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
        // A SteamGridDB entry has no Steam assets by definition: it was chosen
        // precisely because Steam's were missing or wrong.
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
            // Steam first, for the whole set.
            for kind in KINDS {
                for url in steam_urls(app_id, kind) {
                    if let Some((b, i)) = usable(&client, &url, kind) {
                        found.push((kind, b, i, Source::Steam));
                        break;
                    }
                }
            }
            m.steam_complete = found.len() == KINDS.len();

            // Only if Steam cannot complete the set does SteamGridDB get
            // asked, and then for every field -- a Steam cover beside a
            // SteamGridDB wordmark is two artists' work in one card.
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

            // A hero may fall back to the wide store capsule: same shape, so a
            // legitimate substitute even at lower quality. A cover never falls
            // back this way -- that is what composing is for.
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
        let encoded = if kind == Kind::Logo {
            // Wordmarks are frequently a small image inside a large transparent
            // canvas; trimmed, they fill the space they are given.
            let trimmed = trim_transparent(&img);
            let capped = downscale(&trimmed, kind).unwrap_or(trimmed);
            let mut out = std::io::Cursor::new(Vec::new());
            match capped.write_to(&mut out, image::ImageFormat::Png) {
                Ok(()) => out.into_inner(),
                Err(_) => raw.to_vec(),
            }
        } else {
            resize(&raw, kind).unwrap_or_else(|| raw.to_vec())
        };
        write_cached(&path_for(&slug, kind), &encoded);
        have.insert(kind, img);
        match kind {
            Kind::Cover => m.cover = source,
            Kind::Hero => m.hero = source,
            Kind::Logo => m.logo = source,
        }
    }

    // No box art anywhere: build one, but only if there is a wordmark to put
    // on it. Key art alone is a handsome blur that identifies nothing.
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

/// One resolution per game at a time.
///
/// A card asks for its cover and the hero asks for its key art at the same
/// moment, and both used to find no manifest and both used to do the whole job
/// -- every download twice. The lock is per game rather than global so
/// unrelated games still resolve in parallel.
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

pub fn fetch(key: &SourceKey, kind: Kind, sgdb_key: Option<&str>) -> Option<Vec<u8>> {
    let slug = key.slug();
    let path = path_for(&slug, kind);

    // The manifest is the authority on whether this has been resolved. A file
    // alone is not: a zero-byte miss and a not-yet-fetched asset look identical
    // on disk.
    if manifest(&slug).is_none() {
        let gate = lock_for(&slug);
        let _held = gate.lock().unwrap_or_else(|e| e.into_inner());
        // Checked again inside the lock: whoever held it may have just done
        // the work, and doing it twice is the thing this exists to prevent.
        if manifest(&slug).is_none() {
            resolve(key, sgdb_key);
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

/// Temp-then-rename, so a half-written file is never mistaken for a cached one
/// -- and never for a miss, which is the same thing at zero bytes.
fn write_cached(path: &std::path::Path, bytes: &[u8]) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if let Some(dir) = path.parent() {
        log_if_err!("art", paths::ensure(dir), "cache dir {}", dir.display());
    }
    let tmp = path.with_extension("tmp");
    match std::fs::write(&tmp, bytes) {
        // Rename is the step that publishes the file. Losing it leaves a .tmp
        // behind and the next launch re-downloads, so it has to be audible.
        Ok(()) => log_if_err!("art", std::fs::rename(&tmp, path), "caching {name}"),
        Err(e) => log_warn!("art", "caching {name}: {e}"),
    }
}

/// Scale an already-decoded image down to its cap, or None if it is small
/// enough already.
fn downscale(img: &image::DynamicImage, kind: Kind) -> Option<image::DynamicImage> {
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= kind.max_edge() {
        return None;
    }
    let scale = kind.max_edge() as f32 / w.max(h) as f32;
    Some(img.resize(
        (w as f32 * scale) as u32,
        (h as f32 * scale) as u32,
        image::imageops::FilterType::Lanczos3,
    ))
}

/// Throw away every cached image and every recorded miss.
///
/// Called when the artwork sources change -- adding a SteamGridDB key must
/// re-resolve everything that previously found nothing, or the key appears to
/// do nothing at all for the games that needed it most.
pub fn clear_cache() -> std::io::Result<()> {
    let dir = paths::cache_dir().join("art");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    paths::ensure(&dir)?;
    std::fs::write(dir.join(".version"), ART_VERSION.to_string())?;
    Ok(())
}

/// Returns None when the original bytes should be stored unchanged -- either
/// because nothing needed doing, or because we could not decode it at all.
fn resize(raw: &[u8], kind: Kind) -> Option<Vec<u8>> {
    let img = image::load_from_memory(raw).ok()?;
    let (w, h) = (img.width(), img.height());

    // Never upscale. An asset smaller than the target is already as good as it
    // is going to get, and enlarging it only costs memory.
    //
    // And when no resize is needed, keep the original bytes rather than
    // re-encoding them. Steam serves many `library_600x900` assets at 300×450
    // already, and running those through the JPEG encoder again is a second
    // generation of loss in exchange for nothing.
    if w.max(h) <= kind.max_edge() {
        return None;
    }

    let scale = kind.max_edge() as f32 / w.max(h) as f32;
    // Lanczos3 costs more than Triangle and this runs once per asset ever, off
    // the UI thread. Downscaled cover art is looked at closely.
    let img = img.resize(
        (w as f32 * scale) as u32,
        (h as f32 * scale) as u32,
        FilterType::Lanczos3,
    );

    let mut out = Cursor::new(Vec::new());
    if kind.keeps_alpha() {
        img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)
            .encode_image(&img.to_rgb8())
            .ok()?;
    }
    Some(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 255) as u8, (y % 255) as u8, 128, 255])
        });
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn a_large_cover_is_scaled_down() {
        let out = resize(&png(600, 900), Kind::Cover).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!(img.height(), COVER_MAX, "longest edge should hit the cap");
        assert_eq!(img.width(), 320);
        // Pixel count is the assertion that matters: it is what decode cost
        // and bitmap memory are proportional to. Byte size deliberately is
        // not asserted -- it depends entirely on content, and a synthetic
        // gradient compresses better as PNG than as JPEG, which is true of
        // almost no real cover art.
        assert!(
            img.width() * img.height() < 600 * 900 / 3,
            "should be well under a third of the pixels"
        );
    }

    /// Enlarging an already-small asset costs memory and buys nothing, and
    /// re-encoding it is a second generation of loss for nothing. Steam serves
    /// plenty of `library_600x900` assets at 300×450, so this is the common
    /// case, not the edge case.
    #[test]
    fn a_small_asset_is_left_completely_alone() {
        assert!(resize(&png(120, 180), Kind::Cover).is_none());
        assert!(resize(&png(300, 450), Kind::Cover).is_none());
        // Exactly at the cap still counts as no work needed.
        assert!(resize(&png(320, COVER_MAX), Kind::Cover).is_none());
    }

    /// The transparent wordmark is the whole design. Flattening it to JPEG
    /// would put a black box behind every hero.
    #[test]
    fn the_wordmark_keeps_its_alpha() {
        let out = resize(&png(1800, 600), Kind::Logo).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert!(img.color().has_alpha(), "logo must stay PNG with alpha");
        assert_eq!(Kind::Logo.mime(), "image/png");
        assert_eq!(Kind::Cover.mime(), "image/jpeg");
    }

    /// Steam answers with a flat grey image rather than a 404 when an asset
    /// does not exist. Battlefield 6's cover is 1.6 KB of exactly that, while
    /// its wide art is 250 KB of the real thing -- so a 200 proves nothing and
    /// this is the check that decides.
    #[test]
    fn a_flat_image_is_recognised_as_a_placeholder() {
        let flat = image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(
            300,
            450,
            image::Luma([128]),
        ));
        assert!(is_placeholder(&flat));

        // Very slightly noisy, as a JPEG of a grey box would be after
        // compression. Still a placeholder.
        let dithered =
            image::DynamicImage::ImageLuma8(image::GrayImage::from_fn(300, 450, |x, y| {
                image::Luma([128 + ((x + y) % 3) as u8])
            }));
        assert!(is_placeholder(&dithered));
    }

    #[test]
    fn real_artwork_is_not_mistaken_for_a_placeholder() {
        // Strong structure, as any cover has.
        let art = image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(300, 450, |x, y| {
            let v = if (x / 20 + y / 20) % 2 == 0 { 20 } else { 230 };
            image::Rgba([v, v, v, 255])
        }));
        assert!(!is_placeholder(&art));

        // A gentle gradient -- dark to light across the frame. Low contrast for
        // artwork, but nowhere near uniform, and it must survive.
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
    fn rubbish_input_is_none_rather_than_a_panic() {
        assert!(resize(b"not an image at all", Kind::Cover).is_none());
        assert!(resize(&[], Kind::Hero).is_none());
    }

    /// A banner in a 2:3 card looks broken however it is fitted. This is the
    /// check that stopped one being used as box art.
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

    /// Steam's wordmarks are frequently a small logo inside a large
    /// transparent canvas. Rainbow Six Siege's has enough padding that the
    /// artwork renders tiny and visibly off-centre in its own box.
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

    /// Soft edges and drop shadows are part of the artwork; trimming to fully
    /// opaque pixels would clip the glow off a wordmark.
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

    /// Every card must carry a real portrait image, so when no box art exists
    /// anywhere, one is built from the game's own key art.
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
        // Built from real artwork, so it must not itself look like a
        // placeholder -- the wordmark alone guarantees variation.
        assert!(!is_placeholder(&composed));
    }

    /// Steam is inconsistent about which filename it publishes an asset under,
    /// and trying one and giving up was leaving real artwork unfetched.
    #[test]
    fn every_kind_has_more_than_one_name_to_try() {
        for kind in [Kind::Cover, Kind::Hero, Kind::Logo] {
            assert!(kind.files().len() > 1, "{kind:?} should have alternatives");
            assert_eq!(kind.file(), kind.files()[0], "canonical name is the first");
        }
        // Rainbow Six Siege 404s on the jpg and serves a perfect 600x900 png.
        assert!(Kind::Cover.files().contains(&"portrait.png"));
    }

    /// Ids reach this from files on disk and from a database, so anything that
    /// is not a plain number must not become a path segment.
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

    /// Re-pointing a game's artwork must not overwrite the original's cache.
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

    /// The real Battlefield 6 case, end to end.
    ///
    /// Its `library_600x900.jpg` is 1.6 KB of grey and its `logo.png` is the
    /// same, while its `library_hero.jpg` is 250 KB of real art and its actual
    /// capsule exists only under a hashed path. Every part of the fallback is
    /// exercised by this one appid, which is why it is the fixture.
    ///
    ///     cargo test live -- --ignored --nocapture
    /// Prints the resolution report for a spread of real games: an old one
    /// Steam has everything for, a recent one it does not, and a couple in
    /// between. This is the "can it certifiably tell" question, answered.
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
    /// Renders a composed cover from a real game's assets so a human can look
    /// at it. Not an assertion -- the question "does this look right" is not
    /// one a test can answer.
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
