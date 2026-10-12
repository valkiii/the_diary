/**
 * On-device log: there is no console on the tablet. Lines are appended to
 * Document/TheDiary/diary.log, which can be copied off over USB (falling back
 * to the private plugin directory without file permission), capped, and the
 * tail is kept in memory for the settings screen.
 */

import {native, path} from './files';

export const SHARED_LOG = '/storage/emulated/0/Document/TheDiary/diary.log';
const MAX_BYTES = 256 * 1024;
const tail: string[] = [];

export function log(msg: string): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const line = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  ${msg}`;
  tail.push(line);
  if (tail.length > 60) {
    tail.shift();
  }
  console.log(`[Diary] ${msg}`);
  const text = line + '\n';
  native
    ?.appendCapped(SHARED_LOG, text, MAX_BYTES)
    .catch(() => path('diary.log').then(p => native?.appendCapped(p, text, MAX_BYTES)))
    .catch(() => {});
}

export function recentLog(): string[] {
  return [...tail];
}
