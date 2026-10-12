/**
 * The stage: riddle's whole scene, played on the plugin's own view.
 *
 * Every element added to or changed in a note costs 60–85 ms on a Manta and
 * blocks the plugin while it runs (a 375-line reply took 32 s), so nothing is
 * animated in the note. Instead the view opens over the page and shows the
 * writer's ink exactly where it was (the real strokes are deleted beneath it),
 * fades it, then Tom's quill writes the reply letter by letter. Like riddle's
 * diary, the reply lingers and fades away; a tap returns to the page sooner.
 */

import {PluginManager} from 'sn-plugin-lib';

import {simplifyLine, type Polyline} from './hand/layout';

export type Segment = {x1: number; y1: number; x2: number; y2: number; at: number};

export type Layer = {
  segs: Segment[];
  /** Pen travel needed to draw the whole layer. */
  total: number;
  /** Pen travel drawn so far (page pixels). */
  pen: number;
  color: string;
  opacity: number;
};

export type Stage = {
  page: {width: number; height: number};
  /** Line width in page pixels. */
  width: number;
  layers: Layer[];
  onTap: (() => void) | null;
};

const TICK_MS = 60;

let stage: Stage | null = null;
const listeners = new Set<() => void>();

export function currentStage(): Stage | null {
  return stage;
}

export function subscribeStage(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function changed() {
  listeners.forEach(fn => fn());
}

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Flatten polylines into segments, each stamped with the pen travel at which it is drawn. */
export function segments(strokes: Polyline[]): {segs: Segment[]; total: number} {
  const segs: Segment[] = [];
  let at = 0;
  for (const s of strokes) {
    if (s.length === 1) {
      segs.push({x1: s[0].x, y1: s[0].y, x2: s[0].x + 1, y2: s[0].y, at: (at += 1)});
    }
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1];
      const b = s[i];
      at += Math.hypot(b.x - a.x, b.y - a.y);
      segs.push({x1: a.x, y1: a.y, x2: b.x, y2: b.y, at});
    }
    at += 1; // a pen lift costs a little time too
  }
  return {segs, total: at};
}

/** Open the view over the page. False if the host would not show it. */
export async function openStage(page: {width: number; height: number}, width: number): Promise<boolean> {
  stage = {page, width, layers: [], onTap: null};
  changed();
  try {
    await PluginManager.showPluginView();
    return true;
  } catch {
    stage = null;
    changed();
    return false;
  }
}

export async function closeStage(): Promise<void> {
  stage = null;
  changed();
  await PluginManager.closePluginView().catch(() => false);
}

function addLayer(strokes: Polyline[], color: string, drawn: boolean): Layer {
  // Every segment is a native view: keep only the points the eye can see.
  const {segs, total} = segments(strokes.map(s => simplifyLine(s)));
  const layer: Layer = {segs, total, pen: drawn ? total : 0, color, opacity: 1};
  stage?.layers.push(layer);
  changed();
  return layer;
}

/** Show strokes at once (the writer's ink, as it is on the page). */
export function show(strokes: Polyline[], color: string): Layer {
  return addLayer(strokes, color, true);
}

/** Write strokes with the quill at `speed` page pixels of pen travel per second. */
export async function write(strokes: Polyline[], color: string, speed: number): Promise<Layer> {
  const layer = addLayer(strokes, color, false);
  const step = (speed * TICK_MS) / 1000;
  while (stage && layer.pen < layer.total) {
    layer.pen = Math.min(layer.total, layer.pen + step);
    changed();
    await wait(TICK_MS);
  }
  return layer;
}

/** Fade a layer away in a few grey steps (e-ink cannot do smooth). */
export async function fade(layer: Layer, ms: number, steps = 4): Promise<void> {
  for (let i = 1; i <= steps && stage; i++) {
    layer.opacity = 1 - i / steps;
    changed();
    await wait(ms / steps);
  }
}

/** Fade every layer away together. */
export async function fadeAll(ms: number, steps = 3): Promise<void> {
  const layers = stage?.layers ?? [];
  const start = layers.map(l => l.opacity);
  for (let i = 1; i <= steps && stage; i++) {
    layers.forEach((l, j) => (l.opacity = start[j] * (1 - i / steps)));
    changed();
    await wait(ms / steps);
  }
}

/** Resolves when the page is tapped (pen or finger). */
export function tapped(): Promise<void> {
  return new Promise(resolve => {
    if (!stage) {
      return resolve();
    }
    stage.onTap = () => {
      if (stage) {
        stage.onTap = null;
      }
      resolve();
    };
  });
}
