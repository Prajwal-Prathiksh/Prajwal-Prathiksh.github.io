// Small helpers that let the Chowka Bhara training scripts stop at any point
// and carry on from the last finished step when they are run again.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';

export const CHECKPOINT_ROOT = resolve('.training');

// Writes beside the target and renames over it, so a crash mid-write never
// leaves a half-written file behind.
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

export const writeJsonAtomic = (path: string, value: unknown) =>
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Typed arrays survive a round trip through the V8 serializer unchanged.
export const writeBinaryAtomic = (path: string, value: unknown) => writeAtomic(path, serialize(value));

export async function readBinary<T>(path: string): Promise<T | null> {
  try {
    return deserialize(await readFile(path)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const removeCheckpoint = (path: string) => rm(path, { recursive: true, force: true });

// A short, stable fingerprint of a run's settings. A checkpoint is reused only
// when the settings that shaped it are the same.
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
