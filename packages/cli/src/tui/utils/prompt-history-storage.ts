/**
 * Persistent prompt-history storage.
 *
 * Stored as JSONL at `~/.noetic/prompt-history.jsonl` — one `{"text": "..."}`
 * record per line, newest at the bottom. JSONL was chosen for two reasons:
 *
 *   1. Append-only writes are atomic at the line granularity, so multiple
 *      noetic processes appending concurrently can't corrupt each other's
 *      records (they may interleave, but each line stays whole).
 *   2. Extending the schema later — timestamps, project tag, model — is a
 *      one-field-per-record addition rather than a breaking format change.
 *
 * History is capped at `MAX_ENTRIES` on disk: when load() detects more than
 * that, it returns the tail and we'll re-trim on the next compaction pass.
 * The PromptInput in-memory state has its own cap, which the persistence
 * layer respects on load.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

//#region Schema

const HistoryRecordSchema = z.object({
  text: z.string().min(1),
});

//#endregion

//#region Constants

const HISTORY_DIR = '.noetic';
const HISTORY_FILE = 'prompt-history.jsonl';
const MAX_ENTRIES = 1000;
const COMPACT_THRESHOLD = MAX_ENTRIES + 200;

//#endregion

//#region Path resolution

/**
 * Resolve the on-disk history path. Exposed for tests so they can point at
 * a temp dir without touching the user's real history file.
 */
export function defaultHistoryPath(): string {
  return join(homedir(), HISTORY_DIR, HISTORY_FILE);
}

//#endregion

//#region Parsing

function parseRecord(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // Skip malformed records rather than failing the whole load — a
    // single corrupt line shouldn't blank the user's history.
    return null;
  }
  const result = HistoryRecordSchema.safeParse(raw);
  return result.success ? result.data.text : null;
}

function encodeRecord(text: string): string {
  return `${JSON.stringify({
    text,
  })}\n`;
}

//#endregion

//#region Public API

/**
 * Read the persisted history. Newest entries are at the **end** of the
 * returned array (matches the JSONL append order); the caller is
 * responsible for any reversal the in-memory model needs.
 *
 * Resolves to `[]` when the file doesn't exist or any IO error occurs —
 * the prompt is still fully usable without a history file.
 */
export async function loadPromptHistory(
  filePath: string = defaultHistoryPath(),
): Promise<string[]> {
  try {
    const contents = await readFile(filePath, 'utf8');
    const out: string[] = [];
    for (const line of contents.split('\n')) {
      const record = parseRecord(line);
      if (record !== null) {
        out.push(record);
      }
    }
    return out.length > MAX_ENTRIES ? out.slice(out.length - MAX_ENTRIES) : out;
  } catch {
    return [];
  }
}

/**
 * Append a single entry. Creates the parent directory and file lazily on
 * first call. Errors are swallowed — a missing-dir or read-only filesystem
 * must NOT crash the prompt; we fall back to session-only history.
 */
export async function appendPromptHistory(
  text: string,
  filePath: string = defaultHistoryPath(),
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    await mkdir(dirname(filePath), {
      recursive: true,
    });
    await appendFile(filePath, encodeRecord(trimmed), 'utf8');
  } catch {
    // Swallow — see jsdoc.
  }
}

/**
 * Rewrite the file with only the last `MAX_ENTRIES` records. Called by the
 * caller on a slow path (session start / explicit compact) so the file
 * doesn't grow unbounded across years of use. Returns the count after
 * compaction, or null if the file was already small enough.
 */
export async function maybeCompactPromptHistory(
  filePath: string = defaultHistoryPath(),
): Promise<number | null> {
  try {
    const contents = await readFile(filePath, 'utf8');
    const lines = contents.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length <= COMPACT_THRESHOLD) {
      return null;
    }
    const kept = lines.slice(lines.length - MAX_ENTRIES);
    await mkdir(dirname(filePath), {
      recursive: true,
    });
    await writeFile(filePath, `${kept.join('\n')}\n`, 'utf8');
    return kept.length;
  } catch {
    return null;
  }
}

//#endregion
