/**
 * Persistence for session files. Single JSON snapshot per session,
 * overwritten atomically each turn via tmp-write + rename.
 *
 * Concurrent-write detection is advisory: `saveSession` compares the on-disk
 * mtime to the caller's `lastKnownMtime` and returns `conflict: true` when a
 * newer write is detected. The caller decides whether to warn or proceed.
 */

import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionFilePath, sessionsDirFor, sessionsRootDir } from './paths.js';
import type { SessionFile, SessionMetadata } from './types.js';
import { SessionFileV1Schema, toSessionMetadata } from './types.js';

//#region Errors

function isEnoent(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

//#endregion

//#region Save

export interface SaveOptions {
  /** Most recent mtime observed for this session, in ms since epoch. If the
   *  on-disk mtime exceeds this value before our write, the result carries
   *  `conflict: true` so the caller can warn about a concurrent writer. */
  lastKnownMtimeMs?: number;
}

export interface SaveResult {
  /** Effective mtime after our write (ms since epoch). Feed back into
   *  `lastKnownMtimeMs` on the next save. */
  mtimeMs: number;
  /** Whether a newer on-disk mtime was observed before we overwrote. */
  conflict: boolean;
}

export async function saveSession(file: SessionFile, opts?: SaveOptions): Promise<SaveResult> {
  const dir = sessionsDirFor(file.cwd);
  await mkdir(dir, {
    recursive: true,
  });
  const finalPath = sessionFilePath(file.cwd, file.sessionId);
  // Per-write unique suffix so two overlapping saves for the same session
  // (e.g. back-to-back `turn_completed` handlers) don't clobber each other's
  // in-progress tmp file. The suffix is high-entropy to avoid collisions
  // even across process restarts on the same sessionId.
  const tmpPath = `${finalPath}.tmp-${crypto.randomUUID()}`;

  let conflict = false;
  if (opts?.lastKnownMtimeMs !== undefined) {
    try {
      const existing = await stat(finalPath);
      // Add a small tolerance for filesystem mtime resolution (1ms is
      // sufficient on macOS/Linux; NTFS may round to 100ms but this code
      // doesn't run there in practice).
      if (existing.mtimeMs > opts.lastKnownMtimeMs + 1) {
        conflict = true;
      }
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        throw err;
      }
    }
  }

  const payload = JSON.stringify(file, null, 2);
  await Bun.write(tmpPath, payload);
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  const finalStat = await stat(finalPath);
  return {
    mtimeMs: finalStat.mtimeMs,
    conflict,
  };
}

//#endregion

//#region Load

async function readJson(path: string): Promise<unknown> {
  return Bun.file(path).json();
}

async function readAndParse(path: string): Promise<SessionFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  const raw = await readJson(path);
  return SessionFileV1Schema.parse(raw);
}

export async function loadSession(cwd: string, sessionId: string): Promise<SessionFile | null> {
  return readAndParse(sessionFilePath(cwd, sessionId));
}

export async function loadSessionByIdAnywhere(sessionId: string): Promise<SessionFile | null> {
  const root = sessionsRootDir();
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
  for (const project of projects) {
    const candidate = join(root, project, 'sessions', `${sessionId}.json`);
    const parsed = await readAndParse(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

//#endregion

//#region List

async function readMetadataFromDir(dir: string): Promise<SessionMetadata[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const metas: SessionMetadata[] = [];
  for (const name of files) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) {
      continue;
    }
    const path = join(dir, name);
    try {
      const parsed = await readAndParse(path);
      if (parsed === null) {
        continue;
      }
      if (parsed.messageCount === 0) {
        continue;
      }
      metas.push(toSessionMetadata(parsed));
    } catch {
      // Skip malformed files — a single bad write shouldn't poison the picker.
    }
  }
  return metas;
}

function sortNewestFirst(metas: SessionMetadata[]): SessionMetadata[] {
  return [
    ...metas,
  ].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function listSessionsForCwd(cwd: string): Promise<SessionMetadata[]> {
  const metas = await readMetadataFromDir(sessionsDirFor(cwd));
  return sortNewestFirst(metas);
}

export async function listAllSessions(): Promise<SessionMetadata[]> {
  const root = sessionsRootDir();
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const all: SessionMetadata[] = [];
  for (const project of projects) {
    const dir = join(root, project, 'sessions');
    const metas = await readMetadataFromDir(dir);
    all.push(...metas);
  }
  return sortNewestFirst(all);
}

export async function findMostRecentSession(cwd: string): Promise<SessionFile | null> {
  const metas = await listSessionsForCwd(cwd);
  if (metas.length === 0) {
    return null;
  }
  return loadSession(cwd, metas[0].sessionId);
}

//#endregion
