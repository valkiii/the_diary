/**
 * Tom Riddle's hand: lay reply text out as pen polylines on the page.
 *
 * The glyph skeletons are baked offline (tools/atlas, a port of riddle's
 * rasterize → thin → trace pipeline), so here we only wrap words, place
 * glyphs and scale points. Pure logic, no SDK: unit-tested.
 */

import atlasJson from './atlas.json';

export type Pt = {x: number; y: number};
export type Polyline = Pt[];

type Glyph = {a: number; s: number[][]};
type Atlas = {
  px: number;
  ascent: number;
  descent: number;
  lineGap: number;
  space: number;
  glyphs: Record<string, Glyph>;
  kern: Record<string, number>;
};

const atlas = atlasJson as unknown as Atlas;

/** Typographic substitutes for characters the font lacks. */
const SUBSTITUTE: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  ' ': ' ',
  '\t': ' ',
};

export function normalizeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const sub = SUBSTITUTE[ch] ?? ch;
    if (sub === ' ' || sub === '\n' || atlas.glyphs[sub]) {
      out += sub;
    }
  }
  return out;
}

/** Advance width of `text` at font size `px`. */
export function measure(text: string, px: number): number {
  const k = px / atlas.px;
  let w = 0;
  let prev = '';
  for (const ch of text) {
    if (ch === ' ') {
      w += atlas.space;
    } else {
      w += (atlas.glyphs[ch]?.a ?? 0) + (prev ? atlas.kern[prev + ch] ?? 0 : 0);
    }
    prev = ch;
  }
  return w * k;
}

/** Word-wrap to lines no wider than `maxWidth` (a lone long word overflows). */
export function wrap(text: string, px: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of normalizeText(text).split('\n')) {
    let cur = '';
    for (const word of para.split(' ').filter(Boolean)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (!cur || measure(cand, px) <= maxWidth) {
        cur = cand;
      } else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) {
      lines.push(cur);
    }
  }
  return lines;
}

export function lineHeight(px: number): number {
  return ((atlas.ascent - atlas.descent + atlas.lineGap) * px) / atlas.px;
}

/**
 * Polylines for one line of text with its baseline at (x, baselineY).
 * Strokes of the same word that meet end-to-start are joined, which roughly
 * halves the element count (every element costs ~40 ms to insert).
 */
export function inkLine(text: string, x: number, baselineY: number, px: number): Polyline[] {
  return inkWords(text, x, baselineY, px).flat();
}

/** Like inkLine, but grouped word by word, so a reply can appear one word at a time. */
export function inkWords(text: string, x: number, baselineY: number, px: number): Polyline[][] {
  const k = px / atlas.px;
  const words: Polyline[][] = [];
  let out: Polyline[] = [];
  let caret = 0;
  let prev = '';
  for (const ch of text) {
    if (ch === ' ') {
      caret += atlas.space;
      prev = ch;
      if (out.length) {
        words.push(out);
        out = [];
      }
      continue;
    }
    const g = atlas.glyphs[ch];
    if (!g) {
      continue;
    }
    caret += prev ? atlas.kern[prev + ch] ?? 0 : 0;
    for (const flat of g.s) {
      const line: Polyline = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        line.push({x: x + (caret + flat[i]) * k, y: baselineY + flat[i + 1] * k});
      }
      if (line.length >= 2) {
        joinOrPush(out, line, 0, Math.max(2.5, 3 * k));
      }
    }
    caret += g.a;
    prev = ch;
  }
  if (out.length) {
    words.push(out);
  }
  return words;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Append `line`, joining it onto a stroke of the current word it touches. */
function joinOrPush(out: Polyline[], line: Polyline, wordStart: number, tol: number) {
  for (let i = out.length - 1; i >= wordStart; i--) {
    const s = out[i];
    const sEnd = s[s.length - 1];
    if (dist(sEnd, line[0]) <= tol) {
      s.push(...line.slice(1));
      return;
    }
    if (dist(sEnd, line[line.length - 1]) <= tol) {
      s.push(...line.slice(0, -1).reverse());
      return;
    }
    if (dist(s[0], line[line.length - 1]) <= tol) {
      s.unshift(...line.slice(0, -1));
      return;
    }
  }
  out.push(line);
}

export type Laid = {
  /** Polylines line by line. */
  lines: Polyline[][];
  /** The same polylines word by word, in writing order. */
  words: Polyline[][];
  bottom: number;
};

/**
 * Lay a reply out in a column starting at `top`. Returns the polylines line
 * by line (so they can be inked one line at a time) and the bottom edge.
 */
export function layout(
  text: string,
  box: {left: number; top: number; width: number},
  px: number,
): Laid {
  const lh = lineHeight(px);
  const ascent = (atlas.ascent * px) / atlas.px;
  const lines = wrap(text, px, box.width);
  const words = lines.map((t, i) => inkWords(t, box.left, box.top + ascent + i * lh, px));
  return {lines: words.map(w => w.flat()), words: words.flat(), bottom: box.top + lines.length * lh};
}

/** Round and drop consecutive duplicate points (the host wants ints). */
export function toIntPoints(line: Polyline): Pt[] {
  const out: Pt[] = [];
  for (const p of line) {
    const q = {x: Math.round(p.x), y: Math.round(p.y)};
    const last = out[out.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) {
      out.push(q);
    }
  }
  return out;
}

/** Douglas–Peucker: drop points within `eps` px of the line through their neighbours. */
export function simplifyLine(pts: Pt[], eps = 0.8): Pt[] {
  if (pts.length < 3) {
    return pts;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = len < 1e-6 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps) {
    return [a, b];
  }
  return [...simplifyLine(pts.slice(0, at + 1), eps).slice(0, -1), ...simplifyLine(pts.slice(at), eps)];
}
