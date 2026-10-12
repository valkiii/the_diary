/**
 * Live check against a running diary bridge (skipped unless LIVE=1):
 *   LIVE=1 BRIDGE=http://127.0.0.1:8787/v1 TOKEN=… MODELS=claude,gemma4:e2b npx jest live
 */
import * as fs from 'fs';
import {ask} from '../src/oracle';
import {buildMessages, catalogLines, parseAnswer} from '../src/prompt';

const live = process.env.LIVE === '1' ? describe : describe.skip;
const models = (process.env.MODELS ?? 'claude').split(',');
const base = process.env.BRIDGE ?? 'http://127.0.0.1:8787/v1';
const cfg = (model: string) => ({baseUrl: base, apiKey: process.env.TOKEN ?? '', model, reasoning: '', maxTokens: 2000});

const day = (d: number, h: number) => new Date(2026, 9, d, h).getTime() / 1000;
const catalog = [
  {id: day(11, 20), transcript: 'I planted roses in the garden with my grandmother today', reply: 'Roses… tell me, what did she whisper to you?'},
  {id: day(9, 9), transcript: 'I failed my driving test this morning', reply: 'Failure is a teacher. What did it teach you?'},
  {id: day(5, 22), transcript: 'My name is Valentina', reply: 'Valentina. What a lovely name.'},
];

live.each(models)('live diary with %s', model => {
  it('answers in character, in the writer\'s language, remembering', async () => {
    const raw = await ask(cfg(model), buildMessages({transcript: 'Ti ricordi come mi chiamo?', history: [...catalog].reverse(), catalog, remember: true}));
    const a = parseAnswer(raw, catalogLines(catalog).ids);
    console.log(model, 'IT:', raw);
    expect(a.kind).toBe('reply');
    expect((a as any).text).toMatch(/Valentina/);
  }, 120000);

  it('conjures the right page for "show me…"', async () => {
    const raw = await ask(cfg(model), buildMessages({transcript: 'Show me the page about the garden', history: [], catalog, remember: true}));
    console.log(model, 'SHOW:', raw);
    expect(parseAnswer(raw, catalogLines(catalog).ids)).toMatchObject({kind: 'show', memoryId: catalog[0].id});
  }, 120000);

  it('reads a page image when the tablet found no words', async () => {
    const png = fs.readFileSync(process.env.PAGE_PNG ?? '/dev/null').toString('base64');
    if (!png) return;
    const raw = await ask(cfg(model), buildMessages({transcript: '', imageBase64: png, history: [], catalog: [], remember: false}));
    const a = parseAnswer(raw, []);
    console.log(model, 'IMAGE:', raw);
    expect(a.kind).toBe('reply');
    expect((a.transcript ?? '').toLowerCase()).toContain('garden');
  }, 120000);
});
