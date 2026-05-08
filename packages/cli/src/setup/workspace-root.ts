/**
 * Walk up from a starting directory to find the workspace root.
 *
 * The workspace root is the highest ancestor that contains either a
 * `bun.lockb` / `bun.lock` or a `package.json` with a `workspaces` field.
 * Returns null if no such ancestor exists (e.g. running outside a checkout).
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function hasWorkspaceMarker(dir: string): boolean {
  const lockCandidates = [
    'bun.lockb',
    'bun.lock',
  ];
  for (const lock of lockCandidates) {
    try {
      statSync(join(dir, lock));
      return true;
    } catch {
      // continue
    }
  }

  try {
    const pkgPath = join(dir, 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isPkgWithWorkspaces(parsed)) {
      return true;
    }
  } catch {
    // continue
  }

  return false;
}

function isPkgWithWorkspaces(value: unknown): value is { workspaces: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('workspaces' in value)) {
    return false;
  }
  const record: Record<string, unknown> = value;
  const ws = record.workspaces;
  return Array.isArray(ws) || (typeof ws === 'object' && ws !== null);
}

export function findWorkspaceRoot(start: string): string | null {
  let current = start;
  let best: string | null = null;

  while (true) {
    if (hasWorkspaceMarker(current)) {
      best = current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return best;
}
