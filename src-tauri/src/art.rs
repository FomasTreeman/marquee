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

use crate::{log_debug, paths};

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
pub fn fetch(app_id: &str, kind: Kind) -> Option<Vec<u8>> {
    let path = path_for(app_id, kind);

    // A zero-byte file records "Steam has no such asset", so a game without a
    // wordmark is not re-requested on every launch.
    if let Ok(bytes) = std::fs::read(&path) {
        return if bytes.is_empty() { None } else { Some(bytes) };
    }

    let client = crate::meta::http_client()?;

    // Candidates in preference order. Cover and hero fall back to the wide
    // store capsule, which for some recent releases is the only real artwork
    // published at all -- and a wide image cropped into a portrait card beats
    // a grey box by a distance.
    let mut candidates = vec![format!(
        "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/{}",
        kind.file()
    )];
    if kind != Kind::Logo {
        // Fetched inline rather than waited for. The background worker will
        // reach this appid eventually, but a card being drawn now cannot wait
        // several minutes for it -- and both paths share one cache, so this
        // costs at most one request ever.
        if let crate::meta::Fetched::Found(m) = crate::meta::fetch_one(&client, app_id) {
            if !m.header_image.is_empty() {
                candidates.push(m.header_image);
            }
        }
        candidates.push(format!(
            "https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/header.jpg"
        ));
    }

    let mut raw = None;
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
        // A 200 proves nothing: Steam answers with a grey placeholder rather
        // than a 404. Look at the pixels.
        if let Ok(img) = image::load_from_memory(&bytes) {
            if is_placeholder(&img) {
                log_debug!("art", "{app_id}: {url} is a placeholder, trying the next");
                continue;
            }
        }
        raw = Some(bytes);
        break;
    }

    let Some(raw) = raw else {
        log_debug!("art", "no usable {} for {app_id}", kind.file());
        // Every candidate was tried, so this miss is a real one and worth
        // remembering: without it, a game with no artwork costs three requests
        // on every single launch.
        let _ = paths::ensure(path.parent()?);
        let _ = std::fs::write(&path, b"");
        return None;
    };

    // None means "store what arrived": either nothing needed doing, or we
    // could not decode it -- and in the second case the webview may well
    // render what the image crate would not.
    let encoded = resize(&raw, kind).unwrap_or_else(|| raw.to_vec());

    if let Some(dir) = path.parent() {
        let _ = paths::ensure(dir);
    }
    // Temp-then-rename, so a half-written file is never mistaken for a cached
    // one -- and never for a miss, which is the same thing at zero bytes.
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, &encoded).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
    Some(encoded)
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
            let got = fetch("2807960", kind);
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
