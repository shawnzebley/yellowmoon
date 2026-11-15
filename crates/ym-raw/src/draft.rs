//! Draft decoding: a smaller copy of the sensor data for quick previews.
//!
//! The iPhone web app (`web/`) renders its previews through the same `ym render` as its exports,
//! but with `YELLOWMOON_DRAFT=2` or `4` in the environment. [`crate::metadata::probe`] and
//! [`crate::decode::decode`] then return the photo as if the sensor had 2 or 4 times fewer pixels
//! along each edge: each output photosite is the mean of the same-colour photosites of its block,
//! so the Bayer pattern and its phase are kept and the rest of the pipeline runs unchanged on a
//! quarter (or a sixteenth) of the pixels. The decoders themselves and the `_source` and `_bytes`
//! entry points never see the switch. Unset, `1` or anything else: full size, as always.
//!
//! A draft is for looking, not for keeping: noise, sharpness and lens tables read differently on
//! the smaller grid. Exports never set the switch.

use half::f16;

use crate::decode::RawImage;
use crate::layout::{Layout, Plane, Rect};
use crate::metadata::RawMetadata;

/// The environment variable that asks for a draft (`2` or `4`).
pub const DRAFT_ENV: &str = "YELLOWMOON_DRAFT";

/// The draft factor the environment asks for: 2 or 4, else 1 (full size).
#[must_use]
pub fn factor() -> u32 {
    match std::env::var(DRAFT_ENV).ok().as_deref().map(str::trim) {
        Some("2") => 2,
        Some("4") => 4,
        _ => 1,
    }
}

/// A rectangle on the half-size grid: the origin rounded up to a whole 2x2 block of the output
/// (4 source pixels, so the CFA phase is kept) and the size shrunk to match.
fn halve_rect(r: Rect) -> Rect {
    let x = r.x.div_ceil(4) * 4;
    let y = r.y.div_ceil(4) * 4;
    let width = r.width.saturating_sub(x - r.x) / 4 * 2;
    let height = r.height.saturating_sub(y - r.y) / 4 * 2;
    Rect {
        x: x / 2,
        y: y / 2,
        width,
        height,
    }
}

/// The metadata of the half-size photo.
fn halve_meta(meta: &mut RawMetadata, reduced: bool) {
    if reduced {
        meta.width /= 2;
        meta.height /= 2;
    } else {
        meta.width = meta.width / 4 * 2;
        meta.height = meta.height / 4 * 2;
    }
    meta.active_area = meta.active_area.map(halve_rect);
    meta.crop = meta.crop.map(halve_rect);
}

/// Halves a Bayer plane: each output site is the mean of the four same-colour sites of the 4x4
/// source block it stands for.
fn halve_bayer<T: Copy + Default>(
    p: &Plane<T>,
    to: impl Fn(T) -> f32,
    from: impl Fn(f32) -> T,
) -> Plane<T> {
    let w = p.width / 4 * 2;
    let h = p.height / 4 * 2;
    let mut data = vec![T::default(); w * h];
    for y in 0..h {
        let sy = (y / 2) * 4 + (y % 2);
        for x in 0..w {
            let sx = (x / 2) * 4 + (x % 2);
            let at = |yy: usize, xx: usize| to(p.data[yy * p.width + xx]);
            let sum = at(sy, sx) + at(sy, sx + 2) + at(sy + 2, sx) + at(sy + 2, sx + 2);
            data[y * w + x] = from(sum / 4.0);
        }
    }
    Plane {
        width: w,
        height: h,
        data,
    }
}

/// Halves an interleaved RGB plane (Lossless M and S): a 2x2 box mean per channel.
fn halve_rgb(p: &Plane<u16>) -> Plane<u16> {
    let pw = p.width / 3;
    let w = pw / 2;
    let h = p.height / 2;
    let mut data = vec![0u16; w * 3 * h];
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let at = |yy: usize, xx: usize| f32::from(p.data[yy * p.width + xx * 3 + c]);
                let sum = at(2 * y, 2 * x)
                    + at(2 * y, 2 * x + 1)
                    + at(2 * y + 1, 2 * x)
                    + at(2 * y + 1, 2 * x + 1);
                data[(y * w + x) * 3 + c] = (sum / 4.0).round() as u16;
            }
        }
    }
    Plane {
        width: w * 3,
        height: h,
        data,
    }
}

fn halve_image(mut raw: RawImage) -> RawImage {
    let reduced = raw.is_reduced();
    if reduced {
        raw.data = halve_rgb(&raw.data);
    } else {
        // The mean of four 16-bit values fits a u16; rounding keeps it unbiased.
        raw.data = halve_bayer(&raw.data, f32::from, |v| v.round() as u16);
        raw.qstep = raw
            .qstep
            .as_ref()
            .map(|q| halve_bayer(q, f32::from, f16::from_f32));
    }
    halve_meta(&mut raw.meta, reduced);
    if let Layout::Bayer {
        active_area, crop, ..
    } = &mut raw.layout
    {
        *active_area = active_area.map(halve_rect);
        *crop = crop.map(halve_rect);
    }
    raw
}

/// The metadata as a draft of `factor` (1, 2 or 4) would report it.
#[must_use]
pub fn draft_metadata(mut meta: RawMetadata, factor: u32) -> RawMetadata {
    let reduced = matches!(meta.layout(), Layout::Ycbcr { .. });
    let mut f = factor;
    while f >= 2 {
        halve_meta(&mut meta, reduced);
        f /= 2;
    }
    meta
}

/// The image as a draft of `factor` (1, 2 or 4).
#[must_use]
pub fn draft_image(mut raw: RawImage, factor: u32) -> RawImage {
    let mut f = factor;
    while f >= 2 && raw.data.width >= 8 && raw.data.height >= 8 {
        raw = halve_image(raw);
        f /= 2;
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_half_rect_keeps_the_cfa_phase_and_stays_inside() {
        let r = halve_rect(Rect {
            x: 2,
            y: 6,
            width: 101,
            height: 50,
        });
        assert_eq!((r.x % 2, r.y % 2), (0, 0));
        assert!(2 * r.x >= 2 && 2 * (r.x + r.width) <= 103);
        assert!(2 * r.y >= 6 && 2 * (r.y + r.height) <= 56);
    }

    #[test]
    fn a_half_bayer_plane_averages_same_colour_sites() {
        // Each site holds its colour index (0..4 by phase) times 100 plus its block row.
        let (w, h) = (8, 8);
        let data: Vec<u16> = (0..w * h)
            .map(|i| {
                let (y, x) = (i / w, i % w);
                ((y % 2) * 2 + x % 2) as u16 * 100
            })
            .collect();
        let half = halve_bayer(
            &Plane {
                width: w,
                height: h,
                data,
            },
            f32::from,
            |v| v.round() as u16,
        );
        assert_eq!((half.width, half.height), (4, 4));
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(half.data[y * 4 + x], ((y % 2) * 2 + x % 2) as u16 * 100);
            }
        }
    }
}
