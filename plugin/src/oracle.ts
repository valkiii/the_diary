/**
 * The spirit in the diary: any OpenAI-compatible /chat/completions endpoint.
 *
 * That covers the diary bridge (bridge/ — Claude through your Claude Code
 * login, or a local Ollama model), Ollama directly, and hosted APIs. The
 * reply is short, so the request is not streamed: React Native's fetch
 * cannot read a streaming body anyway.
 */

import {native} from './files';
import type {ChatMessage} from './prompt';

export type OracleConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Sent as reasoning_effort when set ("none" keeps Gemma 4 from thinking). */
  reasoning: string;
  maxTokens: number;
};

export class OracleError extends Error {
  constructor(message: string, readonly spoken: string) {
    super(message);
  }
}

export function chatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

export function requestBody(cfg: OracleConfig, messages: ChatMessage[], capField = 'max_tokens'): string {
  const body: Record<string, unknown> = {model: cfg.model, stream: false, messages, [capField]: cfg.maxTokens};
  if (cfg.reasoning) {
    body.reasoning_effort = cfg.reasoning;
  }
  return JSON.stringify(body);
}

/** Pull the assistant text out of a chat-completions response. */
export function replyText(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return '';
}

/**
 * fetch, except that plain http:// goes through the native socket client: the
 * plugin host allows no cleartext traffic, and the bridge is http on the LAN.
 */
export const diaryFetch: typeof fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (!/^http:\/\//i.test(url) || !native?.httpPost) {
    return fetch(input, init);
  }
  const {status, body} = await native.httpPost(url, init?.headers ?? {}, String(init?.body ?? ''), 120_000);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}) as typeof fetch;

/** Ask the spirit. Throws OracleError with a line Tom can write on failure. */
export async function ask(cfg: OracleConfig, messages: ChatMessage[], fetchImpl: typeof fetch = diaryFetch): Promise<string> {
  if (!cfg.baseUrl.trim()) {
    throw new OracleError('no server configured', 'The diary has no spirit yet. Open its settings and tell it where to find one.');
  }
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (cfg.apiKey.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  }
  const post = (capField: string) =>
    fetchImpl(chatUrl(cfg.baseUrl), {method: 'POST', headers, body: requestBody(cfg, messages, capField)});

  let res: Response;
  try {
    // OpenAI's own API wants max_completion_tokens; most compatible servers only know max_tokens.
    res = await post(/api\.openai\.com/.test(cfg.baseUrl) ? 'max_completion_tokens' : 'max_tokens');
    if (res.status === 400) {
      // OpenAI's newest models only accept max_completion_tokens (riddle does the same retry).
      const text = await res.text();
      if (/max_completion_tokens/.test(text)) {
        res = await post('max_completion_tokens');
      } else {
        throw new OracleError(`HTTP 400: ${text.slice(0, 300)}`, 'The ink will not take. The spirit refused the page.');
      }
    }
  } catch (e) {
    if (e instanceof OracleError) {
      throw e;
    }
    throw new OracleError(`network: ${String(e)}`, 'The diary cannot reach its spirit. Is it awake, and on the same network?');
  }
  if (res.status === 401 || res.status === 403) {
    throw new OracleError(`HTTP ${res.status}`, 'The spirit does not know this diary. Check the key in its settings.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OracleError(`HTTP ${res.status}: ${text.slice(0, 300)}`, 'The ink blurs. The spirit is troubled and cannot answer.');
  }
  const json = await res.json().catch(() => null);
  const text = replyText(json);
  if (!text.trim()) {
    throw new OracleError(`empty reply: ${JSON.stringify(json).slice(0, 300)}`, 'The page stays silent.');
  }
  return text;
}
