//! Bake Tom Riddle's hand into a glyph atlas the plugin can lay out at runtime.
//!
//! For every character the diary might need, rasterize the Dancing Script
//! glyph, thin it to a 1px skeleton (Zhang-Suen), trace the skeleton into
//! polylines and simplify them. The plugin then only has to place glyphs and
//! scale points: no font parsing or image work happens on the tablet.
//!
//! The rasterize/thin/trace pipeline is ported from riddle's `src/script.rs`
//! (MIT, Maxime Rivest — https://github.com/MaximeRivest/riddle). The changes:
//! glyphs are rasterized one at a time with padding (so cursive entry strokes
//! with a negative bearing are kept), and the traced paths are simplified.
//!
//! Usage: cargo run --release -- <out.json>

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use std::fmt::Write as _;

const FONT_TTF: &[u8] = include_bytes!("../fonts/DancingScript.ttf");
/// Raster size. Points are stored in these pixel units; the plugin scales.
const PX: f32 = 240.0;
const PAD: i32 = 96;
/// Douglas-Peucker tolerance, in raster pixels.
const SIMPLIFY: f32 = 1.2;
/// Moving-average half window used to iron out the skeleton's pixel stairs.
const SMOOTH: usize = 3;

struct Mask {
    w: usize,
    h: usize,
    m: Vec<bool>,
}

impl Mask {
    fn at(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h && self.m[y as usize * self.w + x as usize]
    }
}

/// Rasterize one glyph with its origin at (PAD, PAD + ascent).
fn rasterize(font: &FontRef, c: char) -> Option<(Mask, f32)> {
    let scaled = font.as_scaled(PxScale::from(PX));
    let id = scaled.glyph_id(c);
    if id.0 == 0 {
        return None;
    }
    let adv = scaled.h_advance(id);
    let w = (adv.ceil() as i32 + PAD * 2).max(1) as usize;
    let h = (scaled.height().ceil() as i32 + PAD * 2).max(1) as usize;
    let mut m = vec![false; w * h];
    let mut g = id.with_scale(PxScale::from(PX));
    g.position = ab_glyph::point(PAD as f32, PAD as f32 + scaled.ascent());
    if let Some(outline) = font.outline_glyph(g) {
        let b = outline.px_bounds();
        outline.draw(|x, y, cov| {
            if cov > 0.5 {
                let px = b.min.x as i32 + x as i32;
                let py = b.min.y as i32 + y as i32;
                if px >= 0 && py >= 0 && (px as usize) < w && (py as usize) < h {
                    m[py as usize * w + px as usize] = true;
                }
            }
        });
    }
    Some((Mask { w, h, m }, adv))
}

/// Zhang-Suen thinning (from riddle).
fn thin(mask: &mut Mask) {
    let (w, h) = (mask.w, mask.h);
    let idx = |x: usize, y: usize| y * w + x;
    loop {
        let mut changed = false;
        for phase in 0..2 {
            let mut clear = Vec::new();
            for y in 1..h.saturating_sub(1) {
                for x in 1..w.saturating_sub(1) {
                    if !mask.m[idx(x, y)] {
                        continue;
                    }
                    let p = [
                        mask.m[idx(x, y - 1)],
                        mask.m[idx(x + 1, y - 1)],
                        mask.m[idx(x + 1, y)],
                        mask.m[idx(x + 1, y + 1)],
                        mask.m[idx(x, y + 1)],
                        mask.m[idx(x - 1, y + 1)],
                        mask.m[idx(x - 1, y)],
                        mask.m[idx(x - 1, y - 1)],
                    ];
                    let b: u32 = p.iter().map(|&v| v as u32).sum();
                    if !(2..=6).contains(&b) {
                        continue;
                    }
                    let a = (0..8).filter(|&i| !p[i] && p[(i + 1) % 8]).count();
                    if a != 1 {
                        continue;
                    }
                    let (c1, c2) = if phase == 0 {
                        (!(p[0] && p[2] && p[4]), !(p[2] && p[4] && p[6]))
                    } else {
                        (!(p[0] && p[2] && p[6]), !(p[0] && p[4] && p[6]))
                    };
                    if c1 && c2 {
                        clear.push(idx(x, y));
                    }
                }
            }
            if !clear.is_empty() {
                changed = true;
                for i in clear {
                    mask.m[i] = false;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

/// Trace the skeleton into polylines (from riddle), ordered left to right.
/// Each path says whether it is an isolated blob (a dot) rather than a spur.
fn trace(mask: &Mask) -> Vec<(Vec<(i32, i32)>, bool)> {
    let (w, h) = (mask.w as i32, mask.h as i32);
    let neighbors = |x: i32, y: i32| -> Vec<(i32, i32)> {
        let mut out = Vec::new();
        // 4-neighbours first so paths prefer straight steps over diagonals.
        for (dx, dy) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)] {
            if mask.at(x + dx, y + dy) {
                out.push((x + dx, y + dy));
            }
        }
        out
    };
    let mut seen = vec![false; (w * h) as usize];
    let mut starts = Vec::new();
    for y in 0..h {
        for x in 0..w {
            if mask.at(x, y) && neighbors(x, y).len() == 1 {
                starts.push((x, y));
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            if mask.at(x, y) {
                starts.push((x, y));
            }
        }
    }
    let mut strokes = Vec::new();
    for (sx, sy) in starts {
        if seen[(sy * w + sx) as usize] {
            continue;
        }
        let mut path = vec![(sx, sy)];
        seen[(sy * w + sx) as usize] = true;
        let (mut cx, mut cy) = (sx, sy);
        while let Some((nx, ny)) = neighbors(cx, cy).into_iter().find(|&(nx, ny)| !seen[(ny * w + nx) as usize]) {
            seen[(ny * w + nx) as usize] = true;
            path.push((nx, ny));
            cx = nx;
            cy = ny;
        }
        if path.len() >= 6 {
            strokes.push((path, false));
            continue;
        }
        let isolated = path.iter().all(|&(px, py)| neighbors(px, py).iter().all(|n| path.contains(n)));
        if isolated {
            strokes.push((path, true));
        }
    }
    strokes.sort_by_key(|(s, _)| s.iter().map(|&(x, _)| x).min().unwrap_or(0));
    strokes
}

fn simplify(pts: &[(f32, f32)], eps: f32) -> Vec<(f32, f32)> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let (a, b) = (pts[0], pts[pts.len() - 1]);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = (dx * dx + dy * dy).sqrt();
    let mut worst = (0.0f32, 0usize);
    for (i, p) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
        let d = if len < 1e-6 {
            ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt()
        } else {
            ((p.0 - a.0) * dy - (p.1 - a.1) * dx).abs() / len
        };
        if d > worst.0 {
            worst = (d, i);
        }
    }
    if worst.0 <= eps {
        return vec![a, b];
    }
    let mut left = simplify(&pts[..=worst.1], eps);
    let right = simplify(&pts[worst.1..], eps);
    left.pop();
    left.extend(right);
    left
}

/// Moving average that keeps the end points, so joins between glyphs stay put.
fn smooth(pts: &[(f32, f32)], half: usize) -> Vec<(f32, f32)> {
    let n = pts.len();
    (0..n)
        .map(|i| {
            if i == 0 || i == n - 1 {
                return pts[i];
            }
            let h = half.min(i).min(n - 1 - i);
            let (mut sx, mut sy) = (0.0, 0.0);
            for p in &pts[i - h..=i + h] {
                sx += p.0;
                sy += p.1;
            }
            let c = (2 * h + 1) as f32;
            (sx / c, sy / c)
        })
        .collect()
}

/// A dot (period, i-dot) thins to a pixel or two: ink it as a tiny closed loop.
fn dot(pts: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let c = pts.len() as f32;
    let (cx, cy) = (pts.iter().map(|p| p.0).sum::<f32>() / c, pts.iter().map(|p| p.1).sum::<f32>() / c);
    let r = PX / 60.0;
    (0..=6).map(|i| {
        let a = i as f32 * std::f32::consts::TAU / 6.0;
        (cx + r * a.cos(), cy + r * a.sin())
    }).collect()
}

fn charset() -> Vec<char> {
    let mut cs: Vec<char> = (0x21u32..=0x7e).chain(0xa1..=0xff).chain(0x100..=0x17f).filter_map(char::from_u32).collect();
    cs.extend(['‘', '’', '“', '”', '–', '—', '…', '‹', '›', '€']);
    cs
}

fn main() {
    let out = std::env::args().nth(1).expect("usage: atlas <out.json>");
    let font = FontRef::try_from_slice(FONT_TTF).expect("font");
    let scaled = font.as_scaled(PxScale::from(PX));
    let chars = charset();

    let mut json = String::new();
    write!(
        json,
        "{{\"px\":{},\"ascent\":{:.1},\"descent\":{:.1},\"lineGap\":{:.1},\"space\":{:.1},\"glyphs\":{{",
        PX,
        scaled.ascent(),
        scaled.descent(),
        scaled.line_gap(),
        scaled.h_advance(scaled.glyph_id(' '))
    )
    .unwrap();

    let mut kept = Vec::new();
    let mut first = true;
    let mut total_strokes = 0;
    for &c in &chars {
        let Some((mut mask, adv)) = rasterize(&font, c) else { continue };
        thin(&mut mask);
        let base_y = PAD as f32 + scaled.ascent();
        let strokes: Vec<Vec<(f32, f32)>> = trace(&mask)
            .into_iter()
            .map(|(s, is_dot)| {
                let pts: Vec<(f32, f32)> = s.iter().map(|&(x, y)| (x as f32 - PAD as f32, y as f32 - base_y)).collect();
                if is_dot {
                    return dot(&pts);
                }
                simplify(&smooth(&pts, SMOOTH), SIMPLIFY)
            })
            .collect();
        total_strokes += strokes.len();
        kept.push(c);
        if !first {
            json.push(',');
        }
        first = false;
        let key = match c {
            '"' => "\\\"".to_string(),
            '\\' => "\\\\".to_string(),
            _ => c.to_string(),
        };
        write!(json, "\"{key}\":{{\"a\":{adv:.1},\"s\":[").unwrap();
        for (i, s) in strokes.iter().enumerate() {
            if i > 0 {
                json.push(',');
            }
            json.push('[');
            for (j, (x, y)) in s.iter().enumerate() {
                if j > 0 {
                    json.push(',');
                }
                write!(json, "{},{}", x.round() as i32, y.round() as i32).unwrap();
            }
            json.push(']');
        }
        json.push_str("]}");
    }
    json.push_str("},\"kern\":{");
    let mut first = true;
    let mut pairs = 0;
    for &a in &kept {
        for &b in &kept {
            let k = scaled.kern(scaled.glyph_id(a), scaled.glyph_id(b));
            if k.abs() >= 0.5 {
                let esc = |c: char| match c {
                    '"' => "\\\"".to_string(),
                    '\\' => "\\\\".to_string(),
                    _ => c.to_string(),
                };
                if !first {
                    json.push(',');
                }
                first = false;
                write!(json, "\"{}{}\":{:.1}", esc(a), esc(b), k).unwrap();
                pairs += 1;
            }
        }
    }
    json.push_str("}}");
    std::fs::write(&out, json).expect("write");
    eprintln!("atlas: {} glyphs, {} strokes, {} kern pairs -> {}", kept.len(), total_strokes, pairs, out);
}
