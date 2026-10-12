/**
 * One turn of the diary, riddle-style:
 *   the writer rests the pen (or taps the diary's button) →
 *   the page is read → the diary drinks the ink (it fades away) while the
 *   spirit composes → the answer writes itself in Tom's hand, letter by
 *   letter, lingers, and fades. All of that plays on the stage (stage.ts),
 *   over the page; the note itself only loses the writer's strokes.
 * "Show me…" conjures a remembered page back in the writer's own hand, faded.
 *
 * It only ever acts in notes whose name contains the configured word
 * ("diary" by default): drinking the ink deletes strokes.
 */

import {Element, FileUtils, NativeUIUtils, PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';

import {layout, lineHeight, toIntPoints, type Pt} from './hand/layout';
import {native, path} from './files';
import {PenRest, INK_PEN_TYPES} from './hold';
import {log} from './log';
import * as memory from './memory';
import {ask, OracleError} from './oracle';
import {buildMessages, catalogLines, parseAnswer, spokenDate, type Answer, type Memory} from './prompt';
import * as sdk from './sdk';
import {settings} from './settings';
import * as stage from './stage';

export const pen = new PenRest(() => settings().holdRadius);

const BLACK = 0x00;
const FADED = 0x9d;
/** Quill speed, in page pixels of pen travel per second (~10 letters a second). */
const QUILL_SPEED = 2500;
/** The writer's own hand, rewritten when a page is conjured, goes a little faster. */
const RECALL_SPEED = 4000;
const FINELINER = 10;
const DIARY_PATH = '/storage/emulated/0/Note/Diary.note';

let busySince = 0;

export function isDiaryNote(filePath: string): boolean {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  const match = settings().noteMatch.trim().toLowerCase();
  return name.endsWith('.note') && !!match && name.includes(match);
}

export type Outcome = 'done' | 'empty' | 'elsewhere' | 'busy' | 'failed';

/** Entry point for both triggers. Never throws; never runs two turns at once. */
export async function takePage(reason: 'rest' | 'button'): Promise<Outcome> {
  const now = Date.now();
  if (busySince && now - busySince < 3 * 60 * 1000) {
    log(`${reason}: the diary is still busy with the last page`);
    return 'busy';
  }
  busySince = now;
  try {
    return await turn(reason);
  } catch (e) {
    log(`turn failed: ${String(e)}`);
    return 'failed';
  } finally {
    busySince = 0;
    await sdk.freeElements();
  }
}

function bbox(strokes: Pt[][]): {top: number; bottom: number; left: number; right: number} | null {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const s of strokes) {
    for (const p of s) {
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
    }
  }
  return Number.isFinite(top) ? {top, bottom, left, right} : null;
}

async function samePlace(at: sdk.Here): Promise<boolean> {
  try {
    const now = await sdk.here();
    return now.filePath === at.filePath && now.page === at.page;
  } catch {
    return false;
  }
}

async function turn(reason: 'rest' | 'button'): Promise<Outcome> {
  const s = settings();
  const at = await sdk.here();
  if (!/\.note$/i.test(at.filePath) || !isDiaryNote(at.filePath)) {
    if (reason === 'button') {
      await offerDiary();
    }
    return 'elsewhere';
  }
  if (!(await sdk.ensurePermission('plugin.permission.FILE:READ', 'The diary reads the ink on its own pages.'))) {
    return 'failed';
  }
  if (!(await sdk.ensurePermission('plugin.permission.FILE:WRITE', 'The diary drinks your ink and writes its replies.'))) {
    return 'failed';
  }
  const size = await sdk.pageSize(at);
  let elements = await sdk.readPage(at);
  let ink = elements.filter(e => e.type === Element.TYPE_STROKE && INK_PEN_TYPES.includes(e.stroke?.penType ?? -1));
  let tom = elements.filter(sdk.isTomInk);
  if (!ink.length) {
    log(`${reason}: nothing written on the page`);
    return 'empty';
  }
  log(`${reason}: ${ink.length} strokes on page ${at.page + 1} (${tom.length} of Tom's lines)`);

  let transcript = (await sdk.recognize(ink, size)).trim();
  log(`read: ${JSON.stringify(transcript)}`);

  let imageBase64: string | undefined;
  if (s.imageMode === 'always' || (s.imageMode === 'auto' && transcript.replace(/\W/g, '').length < 2)) {
    if (tom.length) {
      // The spirit should see only the writer's ink, not its own last reply.
      await sdk.erase(tom.map(e => e.numInPage), at.page);
      await sdk.repaint();
      elements = await sdk.readPage(at);
      ink = elements.filter(e => e.type === Element.TYPE_STROKE && INK_PEN_TYPES.includes(e.stroke?.penType ?? -1));
      tom = elements.filter(sdk.isTomInk);
    }
    imageBase64 = await pageImage(at);
  }

  const strokes: Pt[][] = [];
  for (const e of ink) {
    strokes.push(await sdk.strokePoints(e));
  }
  const box = bbox(strokes);

  // Ask the spirit at once; the diary drinks the ink while it composes.
  const history = s.remember ? await memory.recent(s.memoryTurns) : [];
  const catalog = s.remember ? await memory.catalog() : [];
  const asking = consult(transcript, imageBase64, history, catalog);

  await pen.whenLifted();
  if (!(await samePlace(at))) {
    log('the page changed before the ink was drunk: nothing done');
    await asking;
    return 'failed';
  }
  // The stage covers the page and shows the ink exactly where it is, so the
  // real strokes can be deleted beneath it unseen.
  const onStage = s.reveal === 'quill' && (await stage.openStage(size, s.inkWidth / 100));
  const mine = onStage ? stage.show(strokes.map(simplify), '#000') : null;
  if (!(await drink([...ink, ...tom], at))) {
    log('could not drink the ink: nothing done');
    if (onStage) {
      await stage.closeStage();
    }
    await asking;
    return 'failed';
  }
  if (mine) {
    await stage.fade(mine, s.fade ? 1600 : 0, s.fade ? 4 : 1);
  }
  const {answer, failed} = await asking;
  transcript = transcript || answer.transcript || '';

  const top = box ? box.top : size.height * 0.08;
  if (answer.kind === 'show') {
    await conjure(answer.memoryId, at, size, onStage);
    if (onStage) {
      await stage.tapped();
      await stage.closeStage();
    }
    return 'done';
  }
  await write(answer.text, at, size, top, BLACK, onStage);
  if (s.remember && !failed && answer.kind === 'reply' && answer.text) {
    await memory.remember(
      {id: Math.floor(Date.now() / 1000), transcript, reply: answer.text},
      {width: size.width, height: size.height, strokes: strokes.map(memory.decimate)},
    );
  }
  if (onStage) {
    // Like riddle: the reply lingers long enough to read, then fades away.
    await Promise.race([stage.tapped(), stage.wait(Math.min(40_000, Math.max(8_000, answer.text.length * 90)))]);
    await stage.fadeAll(1200);
    await stage.closeStage();
  }
  return failed ? 'failed' : 'done';
}

/** Fewer points for the stage: drop those within ~3 px of the last one kept. */
function simplify(stroke: Pt[]): Pt[] {
  const flat = memory.decimate(stroke);
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({x: flat[i], y: flat[i + 1]});
  }
  return out;
}

/** Ask the spirit. Never throws: a failure becomes a line for Tom to write. */
async function consult(
  transcript: string,
  imageBase64: string | undefined,
  history: Memory[],
  catalog: Memory[],
): Promise<{answer: Answer; failed: boolean}> {
  const s = settings();
  if (!(await sdk.ensurePermission('plugin.permission.INTERNET', 'The diary needs the network to reach its spirit.'))) {
    return {failed: true, answer: {kind: 'reply', text: 'The diary may not reach its spirit. Allow it the network in Settings, then write again.'}};
  }
  try {
    const started = Date.now();
    const raw = await ask(
      {baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, reasoning: s.reasoning, maxTokens: s.maxTokens},
      buildMessages({transcript, imageBase64, history, catalog, remember: s.remember}),
    );
    log(`spirit answered in ${Date.now() - started} ms: ${JSON.stringify(raw.slice(0, 300))}`);
    return {failed: false, answer: parseAnswer(raw, catalogLines(catalog).ids)};
  } catch (e) {
    log(`spirit: ${e instanceof OracleError ? e.message : String(e)}`);
    return {failed: true, answer: {kind: 'reply', text: e instanceof OracleError ? e.spoken : 'The ink blurs.'}};
  }
}

/** Delete the writer's strokes (and any of Tom's lines) from the note. */
async function drink(elements: Element[], at: sdk.Here): Promise<boolean> {
  if (!(await sdk.erase(elements.map(e => e.numInPage), at.page))) {
    return false;
  }
  await sdk.repaint();
  return true;
}

async function pageImage(at: sdk.Here): Promise<string | undefined> {
  if (!native) {
    return undefined;
  }
  const png = await path('page.png');
  try {
    if (!(await sdk.renderPng(at, png))) {
      log('generateNotePng failed: sending words only');
      return undefined;
    }
    return (await native.readBase64(png)) ?? undefined;
  } finally {
    await native.remove(png).catch(() => false);
  }
}

/** Font size and column for the page, shrinking the hand if a reply is long. */
function fit(text: string, size: sdk.Size, top: number, scale: number) {
  const margin = size.width * 0.08;
  const width = size.width - 2 * margin;
  const minTop = size.height * 0.05;
  const maxBottom = size.height * 0.95;
  let px = scale * size.width;
  for (let i = 0; i < 6; i++) {
    const probe = layout(text, {left: margin, top: 0, width}, px);
    const height = probe.bottom;
    if (height <= maxBottom - minTop) {
      const start = Math.max(minTop, Math.min(top, maxBottom - height));
      return layout(text, {left: margin, top: start, width}, px);
    }
    px *= 0.85;
  }
  return layout(text, {left: margin, top: minTop, width}, px);
}

/**
 * Write text in Tom's hand: on the stage letter by letter, or into the note
 * as ink (a line at a time, or all at once). Returns the bottom edge.
 */
async function write(text: string, at: sdk.Here, size: sdk.Size, top: number, color: number, onStage: boolean): Promise<number> {
  const s = settings();
  const laid = fit(text, size, top, s.inkScale);
  if (onStage) {
    await stage.write(laid.words.flat().map(toIntPoints), css(color), QUILL_SPEED);
    return laid.bottom;
  }
  const style = {penWidth: sdk.tomWidth(s.inkWidth), penColor: color, penType: FINELINER};
  const groups = s.reveal === 'line' ? laid.lines : [laid.lines.flat()];
  let drawn = 0;
  for (const group of groups) {
    await pen.whenLifted();
    if (!(await samePlace(at))) {
      log('the page changed while Tom was writing: stopped');
      break;
    }
    drawn += await sdk.inkPolylines(group.map(toIntPoints), at.page, style);
    await sdk.repaint();
  }
  log(`Tom wrote ${drawn} lines of ink`);
  return laid.bottom;
}

function css(grey: number): string {
  const h = grey.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/** Conjure a remembered page: its date, the writer's own hand, Tom's old reply — all faded. */
async function conjure(id: number, at: sdk.Here, size: sdk.Size, onStage: boolean): Promise<void> {
  const s = settings();
  const m = await memory.get(id);
  if (!m) {
    await write('The diary has lost that page.', at, size, size.height * 0.08, BLACK, onStage);
    return;
  }
  log(`conjuring the page of ${spokenDate(id)}`);
  const px = s.inkScale * size.width * 0.75;
  const margin = size.width * 0.08;
  const dateText = spokenDate(id).replace(/^the /, 'The ');
  const date = layout(dateText, {left: margin, top: size.height * 0.04, width: size.width - 2 * margin}, px);
  const style = {penWidth: sdk.tomWidth(s.inkWidth), penColor: FADED, penType: FINELINER};
  if (onStage) {
    await stage.write(date.words.flat().map(toIntPoints), css(FADED), QUILL_SPEED);
  } else {
    await sdk.inkPolylines(date.lines.flat().map(toIntPoints), at.page, style);
    await sdk.repaint();
  }

  let bottom = date.bottom + lineHeight(px) * 0.5;
  const ink = await memory.inkOf(id);
  if (ink && ink.strokes.length) {
    const k = Math.min(size.width / ink.width, size.height / ink.height);
    const strokes = ink.strokes.map(flat => {
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        pts.push({x: Math.round(flat[i] * k), y: Math.round(flat[i + 1] * k)});
      }
      return pts.length === 1 ? [pts[0], {x: pts[0].x + 1, y: pts[0].y}] : pts;
    });
    const box = bbox(strokes);
    // Keep the old page's layout, but start it below the date.
    const dy = box && box.top < bottom ? bottom - box.top : 0;
    const moved = strokes.map(st => st.map(p => ({x: p.x, y: p.y + dy})));
    if (onStage) {
      // The writer's own hand rewrites itself, stroke by stroke.
      await stage.write(moved, css(FADED), RECALL_SPEED);
    } else {
      for (let i = 0; i < moved.length; i += 24) {
        await pen.whenLifted();
        if (!(await samePlace(at))) {
          return;
        }
        await sdk.inkPolylines(moved.slice(i, i + 24), at.page, style);
        await sdk.repaint();
      }
    }
    bottom = box ? box.bottom + dy + lineHeight(px) * 0.4 : bottom;
  } else if (m.transcript) {
    bottom = await write(m.transcript, at, size, bottom, FADED, onStage);
  }
  await write(m.reply, at, size, bottom, FADED, onStage);
}

/** The diary's button in an ordinary note: offer to open (or create) the diary. */
async function offerDiary(): Promise<void> {
  const open = await NativeUIUtils.showRattaDialog(
    'This is not the diary. Write in a note whose name contains "' + settings().noteMatch + '". Open the diary now?',
    'Not now',
    'Open the diary',
    true,
  );
  if (!open) {
    return;
  }
  if (!(await sdk.ensurePermission('plugin.permission.FILE:WRITE', 'The diary needs to create its own note.'))) {
    return;
  }
  const exists = await FileUtils.exists(DIARY_PATH);
  if (!exists) {
    const raw: any = await PluginCommAPI.getNoteSystemTemplates();
    const list: any[] = Array.isArray(raw) ? raw : raw?.result ?? [];
    const blank = list.find(t => /blank/i.test(t?.name ?? '')) ?? list[0];
    const res: any = await PluginFileAPI.createNote({notePath: DIARY_PATH, template: blank?.name ?? 'style_blank', mode: 0, isPortrait: true});
    if (!res?.success) {
      log(`createNote: ${JSON.stringify(res)}`);
      NativeUIUtils.showErrorTipDialog('The diary could not be created. Make a note called "Diary" yourself.');
      return;
    }
  }
  const opened: any = await PluginFileAPI.openFile(DIARY_PATH, -1);
  if (!opened?.success) {
    log(`openFile: ${JSON.stringify(opened)}`);
  }
}
