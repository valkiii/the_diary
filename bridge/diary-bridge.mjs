#!/usr/bin/env node
/**
 * The diary bridge: a tiny OpenAI-compatible endpoint for the Supernote diary.
 *
 * The tablet speaks plain /v1/chat/completions; the bridge answers with
 *   - Claude, through your Claude Code login (`claude -p`), when the model
 *     name starts with "claude" — your Pro/Max plan, no API key; or
 *   - a local Ollama model (e.g. gemma4:e2b) for any other model name.
 *
 * Zero dependencies. Run it on a Mac or a Pi on the same Wi-Fi as the tablet:
 *   node diary-bridge.mjs                    # listens on 0.0.0.0:8787
 *   DIARY_TOKEN=some-secret node diary-bridge.mjs
 *
 * Environment:
 *   PORT (8787)  HOST (0.0.0.0)  DIARY_TOKEN (unset = no auth, LAN only!)
 *   CLAUDE_BIN (claude)  CLAUDE_MODEL (haiku: used for model "claude")
 *   OLLAMA_URL (http://127.0.0.1:11434)  DIARY_LOG_TEXT=1 to log page text
 */

import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const TOKEN = process.env.DIARY_TOKEN ?? '';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'haiku';
const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const LOG_TEXT = process.env.DIARY_LOG_TEXT === '1';
const CLAUDE_TIMEOUT_MS = 120_000;

// claude runs in an empty directory so no project CLAUDE.md or memory rides along.
const WORKDIR = path.join(os.tmpdir(), 'diary-bridge');
mkdirSync(WORKDIR, {recursive: true});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** "claude" → CLAUDE_MODEL; "claude-sonnet" → sonnet; "claude-opus-4" → opus-4… */
export function claudeModel(name) {
  const rest = name.replace(/^claude[-:/ ]?/i, '');
  return rest || CLAUDE_MODEL;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
  return '';
}

/**
 * OpenAI messages → one Claude Code turn. `claude -p` is single-shot, so the
 * diary's earlier pages are folded into the user turn as a transcript.
 */
export function toClaudeTurn(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n\n');
  const convo = messages.filter(m => m.role !== 'system');
  const last = convo[convo.length - 1];
  const earlier = convo.slice(0, -1);
  const content = [];
  if (earlier.length) {
    const lines = earlier.map(m => `${m.role === 'assistant' ? 'You replied' : 'The writer wrote'}: ${textOf(m.content)}`);
    content.push({type: 'text', text: `Earlier in the diary:\n${lines.join('\n')}`});
  }
  const parts = Array.isArray(last?.content) ? last.content : [{type: 'text', text: textOf(last?.content)}];
  for (const p of parts) {
    if (p?.type === 'text' && p.text) {
      content.push({type: 'text', text: p.text});
    } else if (p?.type === 'image_url') {
      const m = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(p.image_url?.url ?? '');
      if (m) content.push({type: 'image', source: {type: 'base64', media_type: m[1], data: m[2]}});
    }
  }
  return {system, content};
}

function askClaude(model, messages) {
  const {system, content} = toClaudeTurn(messages);
  const args = [
    '-p',
    '--model', claudeModel(model),
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  if (system) args.push('--system-prompt', system);
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude timed out'));
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`cannot run ${CLAUDE_BIN}: ${e.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      for (const line of out.split('\n')) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'result') {
          if (msg.is_error) return reject(new Error(`claude: ${msg.result ?? msg.subtype}`));
          return resolve(String(msg.result ?? ''));
        }
      }
      reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(-400)}`));
    });
    child.stdin.end(JSON.stringify({type: 'user', message: {role: 'user', content}}) + '\n');
  });
}

async function askOllama(body) {
  const req = {...body, stream: false};
  // Gemma 4 thinks by default; a diary reply does not need it.
  if (req.reasoning_effort === undefined) req.reasoning_effort = 'none';
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(req),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`ollama ${res.status}: ${text.slice(0, 300)}`), {status: res.status});
  return JSON.parse(text);
}

function completion(model, content) {
  return {
    id: `chatcmpl-diary-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
  };
}

function send(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('page too large'));
        req.destroy();
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && (url.pathname === '/ping' || url.pathname === '/')) {
    return send(res, 200, {ok: true, service: 'diary-bridge'});
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, {error: {message: 'bad or missing token'}});
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return send(res, 200, {object: 'list', data: ['claude', 'claude-haiku', 'claude-sonnet', 'claude-opus'].map(id => ({id, object: 'model'}))});
  }
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) {
    return send(res, 404, {error: {message: 'not found'}});
  }
  const started = Date.now();
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, {error: {message: `bad request: ${e.message}`}});
  }
  const model = String(body.model ?? 'claude');
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === 'image_url'));
  const lastText = textOf(messages[messages.length - 1]?.content);
  log(`← ${model}${hasImage ? ' +page image' : ''}${LOG_TEXT ? ` ${JSON.stringify(lastText.slice(-200))}` : ''}`);
  try {
    if (/^claude/i.test(model)) {
      const text = await askClaude(model, messages);
      log(`→ claude ${Date.now() - started} ms${LOG_TEXT ? ` ${JSON.stringify(text)}` : ''}`);
      return send(res, 200, completion(model, text));
    }
    const out = await askOllama(body);
    log(`→ ollama ${Date.now() - started} ms${LOG_TEXT ? ` ${JSON.stringify(out?.choices?.[0]?.message?.content)}` : ''}`);
    return send(res, 200, out);
  } catch (e) {
    log(`✗ ${e.message}`);
    return send(res, e.status === 404 ? 404 : 502, {error: {message: e.message}});
  }
});

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  server.listen(PORT, HOST, () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal)
      .map(i => i.address);
    log(`diary bridge listening on ${HOST}:${PORT}`);
    for (const ip of ips) log(`  tablet Server setting: http://${ip}:${PORT}/v1`);
    log(`  claude: "${CLAUDE_BIN}" (model "claude" = ${CLAUDE_MODEL}) · ollama: ${OLLAMA_URL}`);
    if (!TOKEN) log('  no DIARY_TOKEN set: anyone on this network can use it');
  });
}

export {server};
