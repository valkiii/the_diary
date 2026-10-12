import {buildMessages, catalogLines, parseAnswer, spokenDate, SENTINEL} from '../src/prompt';
import {ask, chatUrl, OracleError, requestBody} from '../src/oracle';

const mem = (id: number, transcript: string, reply: string) => ({id, transcript, reply});

describe('prompt', () => {
  it('sends the words, history and catalog', () => {
    const msgs = buildMessages({
      transcript: 'Do you remember the garden?',
      history: [mem(1_700_000_000, 'My name is Harry', 'Hello, Harry.')],
      catalog: [mem(1_700_000_000, 'My name is Harry', 'Hello, Harry.')],
      remember: true,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('show:N');
    expect(msgs[1]).toEqual({role: 'user', content: '(an earlier page) My name is Harry'});
    expect(msgs[2]).toEqual({role: 'assistant', content: 'Hello, Harry.'});
    const last = msgs[msgs.length - 1].content as string;
    expect(last).toContain('1. the ');
    expect(last).toContain('Do you remember the garden?');
  });

  it('sends the page image and asks for a transcription when given one', () => {
    const msgs = buildMessages({transcript: '', imageBase64: 'AAAA', history: [], catalog: [], remember: false});
    expect(msgs[0].content).toContain(SENTINEL);
    const parts = msgs[1].content as any[];
    expect(parts[1].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('routes a conjuring directive to the catalog id', () => {
    const ids = catalogLines([mem(300, 'c', 'r'), mem(200, 'b', 'r'), mem(100, 'a', 'r')]).ids;
    expect(parseAnswer('⟦show:2⟧\n⁂ show me the page about b', ids)).toEqual({kind: 'show', memoryId: 200, transcript: 'show me the page about b'});
    expect(parseAnswer(' ⟦ Show : 1 ⟧', ids)).toEqual({kind: 'show', memoryId: 300, transcript: undefined});
    expect(parseAnswer('⟦show:9⟧', ids).kind).toBe('lost');
  });

  it('cleans prose and strips stray directives and markdown', () => {
    const a = parseAnswer('"**Ah**, Harry. ⟦show:1⟧ Tell me more."\n⁂ hello', []);
    expect(a).toEqual({kind: 'reply', text: 'Ah, Harry.  Tell me more.'.replace('  ', ' '), transcript: 'hello'});
  });

  it('drops thinking blocks some local models emit', () => {
    expect(parseAnswer('<think>hmm</think>Hello.', [])).toEqual({kind: 'reply', text: 'Hello.', transcript: undefined});
  });

  it('speaks dates like a diary', () => {
    const id = new Date(2026, 6, 6, 19, 30).getTime() / 1000;
    expect(spokenDate(id)).toBe('the 6th of July 2026, in the evening');
    expect(spokenDate(new Date(2026, 0, 22, 9).getTime() / 1000)).toBe('the 22nd of January 2026, in the morning');
    expect(spokenDate(new Date(2026, 0, 12, 9).getTime() / 1000)).toBe('the 12th of January 2026, in the morning');
  });
});

describe('oracle', () => {
  const cfg = {baseUrl: 'http://pi:8787/v1/', apiKey: 'tok', model: 'claude', reasoning: '', maxTokens: 500};
  const reply = (status: number, body: any) =>
    ({status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body)}) as any;

  it('builds the URL and body', () => {
    expect(chatUrl('http://x:1/v1/')).toBe('http://x:1/v1/chat/completions');
    expect(chatUrl('http://x:1/v1/chat/completions')).toBe('http://x:1/v1/chat/completions');
    expect(JSON.parse(requestBody({...cfg, reasoning: 'none'}, []))).toMatchObject({model: 'claude', max_tokens: 500, reasoning_effort: 'none', stream: false});
    expect(JSON.parse(requestBody(cfg, []))).not.toHaveProperty('reasoning_effort');
  });

  it('returns the assistant text and sends the key', async () => {
    const f = jest.fn(async () => reply(200, {choices: [{message: {content: 'Hello, Harry.'}}]}));
    await expect(ask(cfg, [], f as any)).resolves.toBe('Hello, Harry.');
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer tok');
  });

  it('retries with max_completion_tokens when told to', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(reply(400, {error: {message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."}}))
      .mockResolvedValueOnce(reply(200, {choices: [{message: {content: 'Yes?'}}]}));
    await expect(ask(cfg, [], f)).resolves.toBe('Yes?');
    expect(JSON.parse(f.mock.calls[1][1].body)).toHaveProperty('max_completion_tokens', 500);
  });

  it('gives Tom a line to write when things fail', async () => {
    await expect(ask({...cfg, baseUrl: ''}, [])).rejects.toBeInstanceOf(OracleError);
    const down = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(ask(cfg, [], down as any)).rejects.toMatchObject({spoken: expect.stringContaining('cannot reach')});
    const denied = jest.fn(async () => reply(401, {}));
    await expect(ask(cfg, [], denied as any)).rejects.toMatchObject({spoken: expect.stringContaining('key')});
  });
});

describe('oracle with OpenAI', () => {
  it('sends max_completion_tokens straight away to api.openai.com', async () => {
    const f = jest.fn(async () => ({status: 200, ok: true, json: async () => ({choices: [{message: {content: 'Yes?'}}]})}) as any);
    await ask({baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5-mini', reasoning: 'minimal', maxTokens: 2000}, [], f as any);
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body).toMatchObject({max_completion_tokens: 2000, reasoning_effort: 'minimal'});
    expect(body).not.toHaveProperty('max_tokens');
  });
});
