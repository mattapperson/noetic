/**
 * Filesystem layout for persisted session transcripts.
 *
 * Sessions live under `~/.noetic/projects/{projectSlug}/sessions/{sessionId}.json`.
 * The slug mirrors Claude Code's `~/.claude/projects/{slug}/` convention —
 * cwd with `/` replaced by `-` and the leading separator stripped. Minor
 * collisions are possible (e.g. `/a/b` vs `/a-b`) and are accepted for parity
 * and simplicity; the session file itself carries the full `cwd` so displays
 * and warnings remain unambiguous.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function projectSlugFor(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  if (trimmed.length === 0) {
    return 'root';
  }
  const withoutLeading = trimmed.replace(/^\/+/, '');
  if (withoutLeading.length === 0) {
    return 'root';
  }
  return withoutLeading.replace(/\//g, '-');
}

export function sessionsRootDir(): string {
  const override = process.env.NOETIC_SESSIONS_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), '.noetic', 'projects');
}

export function sessionsDirFor(cwd: string): string {
  return join(sessionsRootDir(), projectSlugFor(cwd), 'sessions');
}

export function sessionFilePath(cwd: string, sessionId: string): string {
  return join(sessionsDirFor(cwd), `${sessionId}.json`);
}
