/**
 * Shared helpers for the QA scripts in this directory: checks that record a
 * result instead of stopping the script, and a way to describe what a promise
 * settled with (an output, a `NoeticError` kind or a `NoeticConfigError` code).
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/core';
import { z } from 'zod';

//#region Types

export type Settled =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly kind?: string;
      readonly code?: string;
      readonly message: string;
      readonly error: unknown;
    };

interface CheckRecord {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

//#endregion

//#region Checks

const records: CheckRecord[] = [];

/** Records one check; never throws. */
export function check(name: string, passed: boolean, detail: unknown = ''): void {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  records.push({
    name,
    passed,
    detail: text,
  });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${passed || text === '' ? '' : `\n      ${text.slice(0, 600)}`}`);
}

/** Runs a section, recording an unexpected throw as a failed check. */
export async function section(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n== ${name}`);
  try {
    await body();
  } catch (error) {
    check(`${name}: finished without an unexpected throw`, false, describeError(error));
  }
}

/** Prints the totals and sets the exit code. */
export function finish(script: string): void {
  const failed = records.filter((r) => !r.passed);
  console.log(`\n${script}: ${records.length - failed.length}/${records.length} checks passed`);
  for (const r of failed) {
    console.log(`  FAILED: ${r.name}`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

//#endregion

//#region Settling

export function describeError(error: unknown): string {
  if (isNoeticConfigError(error)) {
    return `NoeticConfigError ${error.code}: ${error.message}`;
  }
  if (isNoeticError(error)) {
    return `NoeticError ${JSON.stringify(error.noeticError, (k, v) => (k === 'cause' ? String(v) : v))}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** What `promise` settled with, without throwing. */
export async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return {
      ok: true,
      value: await promise,
    };
  } catch (error) {
    if (isNoeticConfigError(error)) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        error,
      };
    }
    if (isNoeticError(error)) {
      return {
        ok: false,
        kind: error.noeticError.kind,
        message: describeError(error),
        error,
      };
    }
    return {
      ok: false,
      message: describeError(error),
      error,
    };
  }
}

export function show(s: Settled): string {
  if (s.ok) {
    return `ok ${JSON.stringify(s.value)?.slice(0, 400)}`;
  }
  return s.message;
}

//#endregion

//#region Misc

export function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `noetic-qa-${prefix}-`));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const SERVER_PATH = join(import.meta.dir, '_ui-server.ts');

const ServerCallSchema = z.object({
  instance: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  meta: z.record(z.string(), z.unknown()),
});

/** One tool call as `_ui-server.ts` logged it. */
export type ServerCall = z.infer<typeof ServerCallSchema>;

/** The calls `_ui-server.ts` appended to `path`; empty when nothing was logged. */
export function readServerLog(path: string): ServerCall[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ServerCallSchema.parse(JSON.parse(line)));
}

//#endregion
