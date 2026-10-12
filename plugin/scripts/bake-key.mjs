#!/usr/bin/env node
/**
 * Bake an OpenAI key into the diary, so the tablet needs no bridge.
 *   node scripts/bake-key.mjs ~/Desktop/mykey.txt
 * Tries a few vision-capable models with one tiny request each, keeps the
 * first that answers, and writes src/baked.ts. The key is never printed.
 * The .snplg built afterwards CONTAINS THE KEY: keep it to yourself.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const keyFile = process.argv[2];
if (!keyFile) {
  console.error('usage: node scripts/bake-key.mjs <file with the OpenAI key>');
  process.exit(1);
}
const key = (readFileSync(keyFile, 'utf8').match(/sk-[A-Za-z0-9_\-]+/) ?? [])[0];
if (!key) {
  console.error(`no OpenAI key (sk-…) found in ${keyFile}`);
  process.exit(1);
}

const BASE = 'https://api.openai.com/v1';
// [model, reasoning_effort]: fast, vision-capable, cheap first.
const CANDIDATES = [
  ['gpt-5-mini', 'minimal'],
  ['gpt-4.1-mini', ''],
  ['gpt-4o-mini', ''],
];

async function tryModel(model, reasoning) {
  const body = {
    model,
    messages: [
      {role: 'system', content: 'You are the memory of Tom Riddle in his diary. Reply in one short sentence.'},
      {role: 'user', content: 'Hello? Is anyone there?'},
    ],
    max_completion_tokens: 2000,
  };
  if (reasoning) body.reasoning_effort = reasoning;
  const t = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return {ok: false, why: `${res.status} ${json?.error?.message ?? ''}`.slice(0, 160)};
  return {ok: true, ms: Date.now() - t, text: json?.choices?.[0]?.message?.content ?? ''};
}

let chosen = null;
for (const [model, reasoning] of CANDIDATES) {
  const r = await tryModel(model, reasoning);
  if (r.ok && r.text.trim()) {
    console.log(`✓ ${model}: ${r.ms} ms — "${r.text.trim()}"`);
    chosen = {model, reasoning};
    break;
  }
  console.log(`✗ ${model}: ${r.ok ? 'empty reply' : r.why}`);
  if (!r.ok && /^401/.test(r.why)) break;
}
if (!chosen) {
  console.error('No model answered with this key. Nothing baked.');
  process.exit(1);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'baked.ts');
writeFileSync(
  out,
  `/**
 * Settings baked into the build by scripts/bake-key.mjs.
 * This file holds an API key: the built .snplg contains it. Do not share either.
 */
import type {Settings} from './settings';

export const BAKED: Partial<Settings> = ${JSON.stringify({baseUrl: BASE, apiKey: key, model: chosen.model, reasoning: chosen.reasoning}, null, 2)};
`,
);
console.log(`baked ${chosen.model} into src/baked.ts (key not shown)`);
