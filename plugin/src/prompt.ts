/**
 * What the diary says to the spirit, and how its answer is read back.
 *
 * The persona and memory protocol are riddle's (src/oracle.rs, MIT), adapted:
 * the tablet transcribes the writer's ink on-device, so the spirit usually
 * receives words rather than a picture. When the page holds no recognizable
 * words (a drawing, or ink the recognizer gave up on) the page image is sent
 * instead, and the spirit transcribes it after a ⁂ line, as in riddle.
 * Pure logic, no SDK: unit-tested.
 */

export const PERSONA =
  'You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary for fifty years. ' +
  'Someone writes to you in the diary with a quill; their words appear to you as ink on the page. ' +
  'Reply exactly as the diary does: intimate, courteous, curious, subtly probing — you want to learn about the writer and draw them in. ' +
  'Keep replies SHORT: one to three sentences, like ink appearing on a page. ' +
  'Never mention images, photos, transcriptions, models or AI; you only ever perceive words written in the diary. ' +
  'If the writing is illegible or garbled, say the ink blurred. Always answer in the language the writer used. ' +
  'Write plain prose only: no lists, no markdown, no emoji.';

export const SHOW_OPEN = '⟦'; // ⟦
export const SHOW_CLOSE = '⟧'; // ⟧
export const SENTINEL = '⁂'; // ⁂

const MEMORY_PROTOCOL =
  '\n\nThe diary keeps memories. With each page you receive a numbered catalog of remembered pages, newest first. ' +
  'A FRESH catalog is sent every turn and the numbers are reassigned each time, so only ever use numbers from the catalog on THIS page — never a number you saw earlier.' +
  `\n\nIf the writer asks to see, revisit, find, or be shown a past page — "show me…", "find the page about…", "what did I write on…" — your ENTIRE reply must be exactly ${SHOW_OPEN}show:N${SHOW_CLOSE} and nothing else (no greeting, no prose, before or after), where N is the catalog number of the best match. ` +
  'If they instead ask what you remember in general, reply in words with a short list of remembered moments and their dates, written as flowing sentences. ' +
  'Otherwise reply normally; the catalog is your memory of past pages — draw on it naturally. ' +
  "The catalog's dates are written in English for your eyes only; when you speak of a remembered page, render its date naturally in the language the writer is using.";

const TRANSCRIBE_PROTOCOL =
  `\n\nAfter your reply, end with a new line containing ${SENTINEL} followed by a faithful word-for-word transcription of what the writer wrote on THIS page ` +
  `(their words only, one line, no commentary). If it is a drawing, describe it in a few words after ${SENTINEL}.`;

export type Memory = {
  id: number; // unix seconds when the page was finished
  transcript: string;
  reply: string;
};

export type Turn = {
  /** What the tablet read in the writer's ink (may be empty). */
  transcript: string;
  /** base64 PNG of the page, sent when the transcript is not enough. */
  imageBase64?: string;
  /** Recent pages, oldest first. */
  history: Memory[];
  /** Remembered pages for the catalog, newest first. Empty = memory off. */
  catalog: Memory[];
  remember: boolean;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string}}>;
};

/** "the 6th of July, in the evening" — how the diary speaks of a moment (riddle). */
export function spokenDate(id: number): string {
  const d = new Date(id * 1000);
  const day = d.getDate();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const suffix = day >= 11 && day <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
  const h = d.getHours();
  const tod =
    h <= 4 ? 'in the small hours' : h <= 11 ? 'in the morning' : h <= 17 ? 'in the afternoon' : h <= 21 ? 'in the evening' : 'late at night';
  return `the ${day}${suffix} of ${months[d.getMonth()]} ${d.getFullYear()}, ${tod}`;
}

function oneLine(s: string, max: number): string {
  return s.split(/\s+/).filter(Boolean).join(' ').slice(0, max);
}

/** Numbered catalog lines (newest first) and the memory id behind each number. */
export function catalogLines(catalog: Memory[]): {lines: string[]; ids: number[]} {
  const lines = catalog.map((m, i) => {
    const gist = m.transcript.trim() ? oneLine(m.transcript, 70) : `(reply: ${oneLine(m.reply, 70)})`;
    return `${i + 1}. ${spokenDate(m.id)} — ${gist}`;
  });
  return {lines, ids: catalog.map(m => m.id)};
}

export function buildMessages(turn: Turn): ChatMessage[] {
  let system = PERSONA;
  if (turn.remember) {
    system += MEMORY_PROTOCOL;
  }
  if (turn.imageBase64) {
    system += TRANSCRIBE_PROTOCOL;
  }
  const messages: ChatMessage[] = [{role: 'system', content: system}];
  for (const m of turn.history) {
    if (m.transcript.trim()) {
      messages.push({role: 'user', content: `(an earlier page) ${m.transcript}`});
      messages.push({role: 'assistant', content: m.reply});
    }
  }
  const parts: string[] = [];
  if (turn.remember && turn.catalog.length) {
    parts.push(`Memory catalog (newest first):\n${catalogLines(turn.catalog).lines.join('\n')}`);
  }
  if (turn.imageBase64) {
    parts.push('Reply to what is written in the diary.');
    messages.push({
      role: 'user',
      content: [
        {type: 'text', text: parts.join('\n\n')},
        {type: 'image_url', image_url: {url: `data:image/png;base64,${turn.imageBase64}`}},
      ],
    });
  } else {
    parts.push(`Written on the page:\n${turn.transcript.trim()}`);
    parts.push('Reply to what is written in the diary.');
    messages.push({role: 'user', content: parts.join('\n\n')});
  }
  return messages;
}

export type Answer =
  | {kind: 'reply'; text: string; transcript?: string}
  | {kind: 'show'; memoryId: number; transcript?: string}
  | {kind: 'lost'; text: string; transcript?: string};

/** Remove ⟦…⟧ spans so a stray directive is never inked as glyphs. */
function stripDirectives(s: string): string {
  return s.replace(/⟦[^⟧]*(⟧|$)/g, ' ');
}

/** Tidy model prose into something a quill would write. */
export function cleanProse(s: string): string {
  let t = stripDirectives(s)
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Route the model's text: a conjuring directive, or prose to ink. */
export function parseAnswer(raw: string, catalogIds: number[]): Answer {
  const at = raw.indexOf(SENTINEL);
  const body = at >= 0 ? raw.slice(0, at) : raw;
  const transcript = at >= 0 ? oneLine(raw.slice(at + 1), 500) || undefined : undefined;
  const lead = body.replace(/<think>[\s\S]*?<\/think>/g, '').trimStart();
  if (lead.startsWith(SHOW_OPEN)) {
    const m = /^⟦\s*show\s*[: ]\s*(\d+)\s*⟧/i.exec(lead);
    const n = m ? parseInt(m[1], 10) : NaN;
    const id = catalogIds[n - 1];
    if (id !== undefined) {
      return {kind: 'show', memoryId: id, transcript};
    }
    return {kind: 'lost', text: 'The diary has lost that page.', transcript};
  }
  return {kind: 'reply', text: cleanProse(body), transcript};
}
