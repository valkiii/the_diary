/**
 * The diary remembers (riddle's memory.rs, ported): every finished page keeps
 * the writer's actual pen strokes, what they wrote and Tom's reply, so Tom can
 * follow the conversation and "show me…" can conjure a page back in the
 * writer's own hand. Everything stays in the plugin directory on the tablet.
 */

import {readJson, removeFile, writeJson} from './files';
import type {Memory} from './prompt';
import type {Pt} from './hand/layout';

const INDEX = 'memories.json';
const MAX_MEMORIES = 200;

export type PageInk = {
  /** Page size the strokes were captured at, for rescaling. */
  width: number;
  height: number;
  /** Each stroke flattened as x0,y0,x1,y1,… in page pixels. */
  strokes: number[][];
};

let entries: Memory[] | null = null;

async function load(): Promise<Memory[]> {
  if (!entries) {
    entries = await readJson<Memory[]>(INDEX, []);
  }
  return entries;
}

/** Drop points closer than ~3 px to the last kept one (riddle's decimate). */
export function decimate(stroke: Pt[]): number[] {
  const out: number[] = [];
  let lx = NaN;
  let ly = NaN;
  stroke.forEach((p, i) => {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (Number.isNaN(lx) || (x - lx) ** 2 + (y - ly) ** 2 >= 9 || i === stroke.length - 1) {
      out.push(x, y);
      lx = x;
      ly = y;
    }
  });
  return out;
}

export async function remember(m: Memory, ink: PageInk | null): Promise<void> {
  const all = await load();
  all.push(m);
  if (ink && ink.strokes.length) {
    await writeJson(`m/${m.id}.json`, ink);
  }
  while (all.length > MAX_MEMORIES) {
    const old = all.shift()!;
    await removeFile(`m/${old.id}.json`);
  }
  await writeJson(INDEX, all);
}

/** The last `n` pages, oldest first. */
export async function recent(n: number): Promise<Memory[]> {
  const all = await load();
  return all.filter(m => m.transcript.trim()).slice(-n);
}

/** Pages for the catalog, newest first. */
export async function catalog(max = 60): Promise<Memory[]> {
  return (await load()).slice(-max).reverse();
}

export async function get(id: number): Promise<Memory | undefined> {
  return (await load()).find(m => m.id === id);
}

export async function inkOf(id: number): Promise<PageInk | null> {
  return readJson<PageInk | null>(`m/${id}.json`, null);
}

export async function count(): Promise<number> {
  return (await load()).length;
}

/** Forget everything. */
export async function forget(): Promise<void> {
  const all = await load();
  for (const m of all) {
    await removeFile(`m/${m.id}.json`);
  }
  entries = [];
  await writeJson(INDEX, []);
}
