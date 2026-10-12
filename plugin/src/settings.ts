/** The diary's settings, kept in settings.json in the plugin directory. */

import {BAKED} from './baked';
import {readJson, writeJson} from './files';

export type ImageMode = 'auto' | 'always' | 'never';
export type Reveal = 'quill' | 'line' | 'all';

export type Settings = {
  /** OpenAI-compatible base URL, e.g. http://192.168.1.20:8787/v1 (the bridge). */
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning: string;
  maxTokens: number;
  /**
   * When to send the page image: 'auto' only when the tablet reads no words
   * (a drawing); 'always' for vision models that should see the page.
   */
  imageMode: ImageMode;
  /** Hold the pen still this long at the end of a stroke to hand the page over. 0 = button only. */
  holdMs: number;
  /** How still "still" is, in page pixels. */
  holdRadius: number;
  /** The diary only acts in notes whose file name contains this (case-insensitive). */
  noteMatch: string;
  remember: boolean;
  /** Recent pages carried into each reply. */
  memoryTurns: number;
  /** Tom's hand: letter height as a fraction of the page width. */
  inkScale: number;
  /** Line thickness of Tom's hand (SDK pen width units, min 100). */
  inkWidth: number;
  /** How Tom's reply appears: written letter by letter by the quill, a line at a time, or all at once. */
  reveal: Reveal;
  /** Fade the writer's ink through grey before it vanishes (riddle's "drinking"). */
  fade: boolean;
};

const BASE: Settings = {
  baseUrl: '',
  apiKey: '',
  model: 'claude',
  reasoning: '',
  maxTokens: 2000,
  imageMode: 'auto',
  holdMs: 1200,
  holdRadius: 12,
  noteMatch: 'diary',
  remember: true,
  memoryTurns: 6,
  inkScale: 0.057,
  inkWidth: 300,
  reveal: 'quill',
  fade: true,
};

/** Baked-in values (e.g. an OpenAI key) become the defaults. */
export const DEFAULTS: Settings = {...BASE, ...BAKED};

let current: Settings = {...DEFAULTS};

export function settings(): Settings {
  return current;
}

export async function loadSettings(): Promise<Settings> {
  const saved = await readJson<Partial<Settings>>('settings.json', {});
  // A blank server, key or model never hides a baked-in one.
  for (const k of ['baseUrl', 'apiKey', 'model'] as const) {
    if (typeof saved[k] === 'string' && !saved[k]!.trim()) {
      delete saved[k];
    }
  }
  current = {...DEFAULTS, ...saved};
  return current;
}

export async function saveSettings(next: Settings): Promise<boolean> {
  current = {...next};
  return writeJson('settings.json', current);
}
