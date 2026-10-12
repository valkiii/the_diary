/**
 * The only module that talks to the note app. Everything with a decision in
 * it lives elsewhere and is unit-tested.
 *
 * Write path, as measured by other plugin authors on Manta/Nomad firmware:
 *  - elements must be allocated with createElement (a plain object is refused);
 *  - insertPageElements / batchUpdatePageElements write the app's in-memory
 *    page, so they are followed by saveCurrentNote + reloadFile to repaint;
 *  - PluginFileAPI.getElements reads the file, so the note is saved first;
 *  - GEO_polygon is an open polyline in page pixels, ~40 ms per element.
 */

import {Element, PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI} from 'sn-plugin-lib';

import {log} from './log';
import type {Pt} from './hand/layout';

type Res<T> = {success?: boolean; result?: T; error?: {code?: number; message?: string}} | null | undefined;

export function unwrap<T>(res: unknown, what: string): T {
  const r = res as Res<T>;
  if (r && r.success) {
    return r.result as T;
  }
  throw new Error(`${what} failed: ${r?.error?.code ?? '?'} ${r?.error?.message ?? JSON.stringify(r)}`);
}

function ok(res: unknown): boolean {
  return (res as Res<unknown>)?.success === true;
}

export type Size = {width: number; height: number};
export type Here = {filePath: string; page: number};

export async function here(): Promise<Here> {
  const filePath = unwrap<string>(await PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath');
  const page = unwrap<number>(await PluginCommAPI.getCurrentPageNum(), 'getCurrentPageNum');
  return {filePath, page};
}

export async function pageSize(at: Here): Promise<Size> {
  const res = await PluginFileAPI.getPageSize(at.filePath, at.page);
  if (ok(res)) {
    return unwrap<Size>(res, 'getPageSize');
  }
  return unwrap<Size>(await PluginCommAPI.getPageDisplaySize(), 'getPageDisplaySize');
}

export async function saveNote(): Promise<void> {
  unwrap<boolean>(await PluginNoteAPI.saveCurrentNote(), 'saveCurrentNote');
}

/** Persist the in-memory page, then make the app redraw it. */
export async function repaint(): Promise<void> {
  await saveNote();
  const res = await PluginCommAPI.reloadFile();
  if (!ok(res)) {
    log(`reloadFile: ${JSON.stringify(res)}`);
  }
}

/** Elements on the current layer of the page, as saved on disk. */
export async function readPage(at: Here): Promise<Element[]> {
  await saveNote();
  return unwrap<Element[]>(await PluginFileAPI.getElements(at.page, at.filePath), 'getElements') ?? [];
}

export async function strokePoints(el: Element): Promise<Pt[]> {
  const acc = el.stroke?.points;
  if (!acc) {
    return [];
  }
  const n = await acc.size();
  return n > 0 ? ((await acc.getRange(0, n)) as Pt[]) : [];
}

export async function recognize(strokes: Element[], size: Size): Promise<string> {
  const res = await PluginCommAPI.recognizeElements(strokes, size);
  if (!ok(res)) {
    log(`recognizeElements: ${JSON.stringify(res)}`);
    return '';
  }
  return String((res as Res<string>)?.result ?? '');
}

export async function renderPng(at: Here, pngPath: string): Promise<boolean> {
  const res = await PluginFileAPI.generateNotePng({notePath: at.filePath, page: at.page, times: 1, pngPath, type: 1});
  return ok(res) && (res as Res<boolean>)?.result !== false;
}

/** How Tom's ink is marked so the diary only ever clears its own lines. */
export const TOM_TAG = 'riddle-diary';

export type InkStyle = {penWidth: number; penColor: number; penType: number};

/** penWidth ≡ 7 (mod 100) marks Tom's lines even if userData is not kept. */
export function tomWidth(width: number): number {
  return Math.max(100, Math.round(width / 100) * 100) + 7;
}

export function isTomInk(el: Element): boolean {
  if (el.type !== Element.TYPE_GEO) {
    return false;
  }
  return el.userData === TOM_TAG || (el.geometry?.penWidth ?? 0) % 100 === 7;
}

async function polylineElement(points: Pt[], page: number, style: InkStyle): Promise<object> {
  const el = unwrap<any>(await PluginCommAPI.createElement(Element.TYPE_GEO), 'createElement');
  el.pageNum = page;
  el.thickness = style.penWidth;
  el.userData = TOM_TAG;
  el.geometry = {
    penColor: style.penColor,
    penType: style.penType,
    penWidth: style.penWidth,
    type: 'GEO_polygon',
    points,
    ellipseCenterPoint: null,
    ellipseMajorAxisRadius: 0,
    ellipseMinorAxisRadius: 0,
    ellipseAngle: 0,
    showLassoAfterInsert: false,
  };
  return el;
}

/** Put polylines on the page. Batched; falls back to one insertGeometry each. */
export async function inkPolylines(polylines: Pt[][], page: number, style: InkStyle): Promise<number> {
  const lines = polylines.filter(p => p.length >= 2);
  if (!lines.length) {
    return 0;
  }
  try {
    const elements: object[] = [];
    for (let i = 0; i < lines.length; i += 32) {
      elements.push(...(await Promise.all(lines.slice(i, i + 32).map(p => polylineElement(p, page, style)))));
    }
    const res = await PluginCommAPI.insertPageElements(elements, page, null);
    if (ok(res)) {
      return lines.length;
    }
    log(`insertPageElements refused: ${JSON.stringify(res)} — one at a time`);
  } catch (e) {
    log(`insertPageElements threw: ${String(e)} — one at a time`);
  }
  let drawn = 0;
  for (const points of lines) {
    const res = await PluginCommAPI.insertGeometry({
      penColor: style.penColor,
      penType: style.penType,
      penWidth: style.penWidth,
      type: 'GEO_polygon',
      points,
      ellipseCenterPoint: null,
      ellipseMajorAxisRadius: 0,
      ellipseMinorAxisRadius: 0,
      ellipseAngle: 0,
      showLassoAfterInsert: false,
    } as any);
    drawn += ok(res) ? 1 : 0;
  }
  return drawn;
}

/** Remove elements by their number on the page (the diary "drinks" them). */
export async function erase(nums: number[], page: number): Promise<boolean> {
  const sorted = Array.from(new Set(nums)).sort((a, b) => a - b);
  if (!sorted.length) {
    return true;
  }
  // batchUpdatePageElements refuses an empty insert list (code 106, seen on a Manta).
  const res = await PluginCommAPI.deletePageElements(sorted, page, null);
  if (!ok(res)) {
    log(`deletePageElements refused: ${JSON.stringify(res)}`);
  }
  return ok(res);
}

export async function freeElements(): Promise<void> {
  try {
    await PluginCommAPI.clearElementCache();
  } catch {
    // nothing cached
  }
}

/** Ask for a permission once; true when granted (now or before). */
export async function ensurePermission(name: string, why: string): Promise<boolean> {
  try {
    if ((await PluginManager.hasPermission(name)) > 0) {
      return true;
    }
    return (await PluginManager.requestPermission(name, why)) > 0;
  } catch (e) {
    log(`permission ${name}: ${String(e)}`);
    return true; // older firmware has no permission system
  }
}
