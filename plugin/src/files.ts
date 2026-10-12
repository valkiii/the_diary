/**
 * The diary's own files (settings, memories, log), all in the plugin
 * directory. Backed by the DiaryFiles native module; without it (tests, or a
 * build that lost the module) everything degrades to "nothing stored".
 */

import {NativeModules} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';

type DiaryFilesModule = {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<boolean>;
  appendCapped(path: string, text: string, maxBytes: number): Promise<boolean>;
  readBase64(path: string): Promise<string | null>;
  remove(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  httpPost(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{status: number; body: string}>;
};

export const native: DiaryFilesModule | null = (NativeModules as any).DiaryFiles ?? null;

let dirPromise: Promise<string> | null = null;

/** The plugin's private directory (no permission needed). */
export function pluginDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = PluginManager.getPluginDirPath().then(d => {
      if (!d) {
        dirPromise = null;
        throw new Error('no plugin directory');
      }
      return String(d).replace(/\/+$/, '');
    });
  }
  return dirPromise;
}

export async function path(name: string): Promise<string> {
  return `${await pluginDir()}/${name}`;
}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  if (!native) {
    return fallback;
  }
  try {
    const text = await native.readText(await path(name));
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJson(name: string, value: unknown): Promise<boolean> {
  if (!native) {
    return false;
  }
  try {
    return await native.writeText(await path(name), JSON.stringify(value));
  } catch {
    return false;
  }
}

export async function removeFile(name: string): Promise<void> {
  try {
    await native?.remove(await path(name));
  } catch {
    // already gone
  }
}
