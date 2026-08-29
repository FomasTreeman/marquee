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

use crate::{log_debug, log_info, paths};

/// Longest edge, in device pixels, for each kind.
///
/// A cover is 188 design px wide and the design scales up to 2×, so 480 covers
/// a HiDPI television with room to spare while being a quarter the pixels of
/// the 600×900 original. The hero is full-bleed, so it keeps real width.
const COVER_MAX: u32 = 480;
const HERO_MAX: u32 = 1920;
const LOGO_MAX: u32 = 640;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

    fn file(self) -> &'static str {
        match self {
            Kind::Cover => "library_600x900.jpg",
            Kind::Hero => "library_hero.jpg",
            Kind::Logo => "logo.png",
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
const ART_VERSION: u32 = 2;

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
        let _ = std::fs::remove_dir_all(&dir);
    }
    let _ = paths::ensure(&dir);
    let _ = std::fs::write(&stamp, ART_VERSION.to_string());
}

fn path_for(app_id: &str, kind: Kind) -> PathBuf {
    paths::cache_dir().join("art").join(format!(
        "{app_id}-{}.{}",
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

pub fn fetch(app_id: &str, kind: Kind, sgdb_key: Option<&str>) -> Option<Vec<u8>> {
    let path = path_for(app_id, kind);

    // A zero-byte file records "no source has this", so a game without a
    // wordmark is not re-asked about on every launch.
    if let Ok(bytes) = std::fs::read(&path) {
        return if bytes.is_empty() { None } else { Some(bytes) };
    }

    let client = crate::meta::http_client()?;

    // Sources in preference order.
    //
    //   1. Steam's own asset. Correct when it exists, and free.
    //   2. SteamGridDB, if a key is configured. Community art, and the only
    //      source for the many games Steam publishes no wordmark for.
    //
    // Notably absent: the wide store capsule as a stand-in for box art. A
    // banner in a 2:3 card looks broken however it is fitted, so a
    // wrong-shaped asset is rejected and compose_cover builds a real one.
    let mut candidates = vec![format!(
        "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/{}",
        kind.file()
    )];

    if let Some(key) = sgdb_key.filter(|k| !k.is_empty()) {
        let want = match kind {
            Kind::Cover => crate::sgdb::Want::Grid,
            Kind::Hero => crate::sgdb::Want::Hero,
            Kind::Logo => crate::sgdb::Want::Logo,
        };
        if let Some(url) = crate::sgdb::best_for_steam_app(&client, key, app_id, want) {
            candidates.push(url);
        }
    }

    if kind == Kind::Hero {
        // A hero may fall back to the wide capsule: both are landscape, so it
        // is the right shape for the slot even if it is lower quality.
        if let crate::meta::Fetched::Found(m) = crate::meta::fetch_one(&client, app_id) {
            if !m.header_image.is_empty() {
                candidates.push(m.header_image);
            }
        }
        candidates.push(format!(
            "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/header.jpg"
        ));
    }

    let mut chosen = None;
    for url in &candidates {
        let Ok(response) = client.get(url).send() else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = response.bytes() else {
            continue;
        };
        let Ok(img) = image::load_from_memory(&bytes) else {
            continue;
        };
        // A 200 proves nothing: Steam answers with a grey placeholder rather
        // than a 404. And the right shape matters as much as the right pixels.
        if is_placeholder(&img) {
            log_debug!("art", "{app_id}: {url} is a placeholder, trying the next");
            continue;
        }
        if !right_shape(kind, img.width(), img.height()) {
            log_debug!(
                "art",
                "{app_id}: {url} is {}x{}, wrong shape for {kind:?}",
                img.width(),
                img.height()
            );
            continue;
        }
        chosen = Some((bytes, img));
        break;
    }

    // Nothing of the right shape exists. For a cover, build one out of the
    // game's own key art rather than leaving a blank card.
    if chosen.is_none() && kind == Kind::Cover {
        // Both are needed. Key art alone gives an anonymous blur; the wordmark
        // is what makes it identifiable, and identifiable is the whole point.
        let hero =
            fetch(app_id, Kind::Hero, sgdb_key).and_then(|b| image::load_from_memory(&b).ok());
        let logo =
            fetch(app_id, Kind::Logo, sgdb_key).and_then(|b| image::load_from_memory(&b).ok());
        if let (Some(hero), Some(logo)) = (hero, logo) {
            log_info!("art", "composed a cover for {app_id} from its key art");
            let composed = compose_cover(&hero, &logo);
            let mut out = std::io::Cursor::new(Vec::new());
            if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)
                .encode_image(&composed.to_rgb8())
                .is_ok()
            {
                let bytes = out.into_inner();
                write_cached(&path, &bytes);
                return Some(bytes);
            }
        }
    }

    let Some((raw, img)) = chosen else {
        log_debug!("art", "no usable {} for {app_id}", kind.file());
        // Every source was tried, so this miss is real and worth remembering:
        // without it, a game with no artwork costs several requests on every
        // launch. Adding a SteamGridDB key clears these.
        let _ = paths::ensure(path.parent()?);
        let _ = std::fs::write(&path, b"");
        return None;
    };

    // Wordmarks are trimmed to their ink before anything else: Steam's are
    // frequently a small logo inside a large transparent canvas.
    let encoded = if kind == Kind::Logo {
        let trimmed = trim_transparent(&img);
        let capped = downscale(&trimmed, kind).unwrap_or(trimmed);
        let mut out = std::io::Cursor::new(Vec::new());
        capped
            .write_to(&mut out, image::ImageFormat::Png)
            .ok()
            .map(|_| out.into_inner())
            .unwrap_or_else(|| raw.to_vec())
    } else {
        // None means "store what arrived": nothing needed doing.
        resize(&raw, kind).unwrap_or_else(|| raw.to_vec())
    };

    write_cached(&path, &encoded);
    Some(encoded)
}

/// Temp-then-rename, so a half-written file is never mistaken for a cached one
/// -- and never for a miss, which is the same thing at zero bytes.
fn write_cached(path: &std::path::Path, bytes: &[u8]) {
    if let Some(dir) = path.parent() {
        let _ = paths::ensure(dir);
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
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
    #[test]
    #[ignore]
    fn a_recent_release_still_gets_artwork() {
        let dir = paths::cache_dir().join("art");
        let _ = std::fs::remove_dir_all(&dir);

        for (kind, must_have) in [(Kind::Cover, true), (Kind::Hero, true), (Kind::Logo, false)] {
            let got = fetch("2807960", kind, None);
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
