/**
 * Persist setup-flow ignore decisions to a dedicated user-global JSON file.
 *
 * Lives at `~/.config/noetic/setup.json` (NOT inside `noetic.config.ts`).
 * The main config file must satisfy the full `AgentConfigSchema` to be
 * loadable at boot; a partial override that only carries
 * `setup.ignoredBinaries` would fail zod parsing and block the CLI from
 * starting. Keeping setup-flow state in a sidecar JSON file sidesteps that
 * coupling and also avoids the round-trip loss problem of trying to rewrite
 * a hand-written TS config (arbitrary functions, imports, comments).
 *
 * Writes are atomic (tmpfile + rename) so a crash mid-serialize can't
 * produce a truncated file. Reads tolerate a missing file, an empty file, or
 * malformed JSON — in those cases we treat the ignore list as empty.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { BinaryId } from './types.js';
import { BinaryIdSchema } from './types.js';

//#region Paths

/**
 * Resolve the effective home dir, preferring `$HOME` (or `$USERPROFILE` on
 * Windows) when set. `os.homedir()` is cached from the user DB at process
 * start and ignores env mutations — tests need the env path to work.
 */
function effectiveHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function userGlobalSetupPath(): string {
  return join(effectiveHome(), '.config', 'noetic', 'setup.json');
}

//#endregion

//#region Schema

const UserSetupFileSchema = z.object({
  ignoredBinaries: z.array(BinaryIdSchema).default([]),
});

type UserSetupFile = z.infer<typeof UserSetupFileSchema>;

//#endregion

//#region Read

/**
 * Read the user-global setup file. Missing, empty, or malformed files are
 * treated as "no decisions recorded yet" — we never block CLI boot on a
 * corrupt setup file.
 */
export async function readUserSetup(): Promise<UserSetupFile> {
  const path = userGlobalSetupPath();
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {
      ignoredBinaries: [],
    };
  }
  try {
    const raw = await file.text();
    if (raw.trim().length === 0) {
      return {
        ignoredBinaries: [],
      };
    }
    const parsed = UserSetupFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        ignoredBinaries: [],
      };
    }
    return parsed.data;
  } catch {
    return {
      ignoredBinaries: [],
    };
  }
}

//#endregion

//#region Write

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), {
    recursive: true,
  });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, {
    encoding: 'utf8',
  });
  renameSync(tmp, path);
}

function serialize(state: UserSetupFile): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

//#endregion

//#region Public API

export type AppendResult =
  | { status: 'written'; path: string }
  | { status: 'already-present'; path: string };

/**
 * Merge `id` into the user-global ignore list. Idempotent: a second call
 * with the same id is a no-op write. Creates the file if it doesn't exist.
 */
export async function appendIgnoredBinary(id: BinaryId): Promise<AppendResult> {
  const path = userGlobalSetupPath();
  const current = await readUserSetup();
  if (current.ignoredBinaries.includes(id)) {
    return {
      status: 'already-present',
      path,
    };
  }
  const next: UserSetupFile = {
    ignoredBinaries: [
      ...current.ignoredBinaries,
      id,
    ],
  };
  atomicWrite(path, serialize(next));
  return {
    status: 'written',
    path,
  };
}

//#endregion
