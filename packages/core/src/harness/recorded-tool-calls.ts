/**
 * The tool calls an execution's step ledger holds (spec 23a § Tool calls in a round).
 *
 * A resumed run replays what its ledger recorded: completed steps with the items they
 * appended, the rounds of an unfinished model loop with theirs, and the calls a cut-off
 * round finished. A host that keeps its own record of tool traffic reads this list to
 * know which calls the resume brings back on its own, so it never adds them twice.
 */

import type { RecordedToolCall, TrailMark } from '@noetic-tools/types';
import { z } from 'zod';
import type { StepLedgerEntry, StepLedgerWindow } from '../runtime/durable/step-ledger';
import { stubOf } from '../runtime/durable/step-ledger';
import type { StepLedgerStore } from './deps/runtime';
import { CALL_KIND, CALL_SEGMENT, ROUND_KIND } from './model-rounds';

//#region Types

const FunctionCallSchema = z.object({
  type: z.literal('function_call'),
  callId: z.string(),
  name: z.string(),
});

const FunctionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  callId: z.string(),
});

const RoundOutputItemsSchema = z.object({
  items: z.array(z.unknown()),
});

/** A call's request, keyed by the ledger entry that holds it. */
interface Request {
  callId: string;
  name: string;
  path: string;
}

//#endregion

//#region Helpers

/** Every item an entry replays: those it appended, and a round's own output items. */
function itemsOf(entry: StepLedgerEntry): unknown[] {
  const appended = entry.items ?? [];
  if (entry.kind !== ROUND_KIND) {
    return appended;
  }
  const round = RoundOutputItemsSchema.safeParse(entry.output);
  return round.success
    ? [
        ...round.data.items,
        ...appended,
      ]
    : appended;
}

/** `scope|callId`: a call id is unique only within the entry that asked for it. */
function keyOf(scope: string, callId: string): string {
  return `${scope}|${callId}`;
}

/** The round a call record sits beneath and the call's id, from the record's path. */
function splitCallPath(path: string): {
  scope: string;
  callId: string;
} | null {
  const at = path.lastIndexOf(CALL_SEGMENT);
  if (at < 0) {
    return null;
  }
  return {
    scope: path.slice(0, at),
    callId: path.slice(at + CALL_SEGMENT.length),
  };
}

/** Note the requests and results one entry holds. */
function collectEntry(
  entry: StepLedgerEntry,
  requests: Map<string, Request>,
  settled: Set<string>,
): void {
  if (entry.kind === CALL_KIND) {
    const call = splitCallPath(entry.path);
    if (call) {
      settled.add(keyOf(call.scope, call.callId));
    }
    return;
  }
  for (const item of itemsOf(entry)) {
    const request = FunctionCallSchema.safeParse(item);
    if (request.success) {
      const key = keyOf(entry.path, request.data.callId);
      if (!requests.has(key)) {
        requests.set(key, {
          callId: request.data.callId,
          name: request.data.name,
          path: entry.path,
        });
      }
      continue;
    }
    const result = FunctionCallOutputSchema.safeParse(item);
    if (result.success) {
      settled.add(keyOf(entry.path, result.data.callId));
    }
  }
}

//#endregion

//#region Public API

/**
 * The tool calls a recovered ledger window holds, in the order they were recorded.
 * A call is `settled` when its result is on record too, in the same entry or as a
 * call record beneath its round.
 */
export function recordedToolCalls(window: StepLedgerWindow): RecordedToolCall[] {
  const requests = new Map<string, Request>();
  const settled = new Set<string>();
  const ordered = [
    ...window.entries.values(),
  ].sort((a, b) => (window.seqs.get(a.path) ?? 0) - (window.seqs.get(b.path) ?? 0));
  for (const entry of ordered) {
    collectEntry(entry, requests, settled);
  }
  return [
    ...requests.entries(),
  ].map(([key, request]) => ({
    ...request,
    settled: settled.has(key),
  }));
}

//#endregion

/** Keep what this execution did before dropping its replay entries. */
export async function keepTrailAndClear(
  store: StepLedgerStore | undefined,
  executionId: string,
): Promise<void> {
  if (!store) {
    return;
  }
  const { entries, seqs } = await store.load(executionId);
  for (const [path, entry] of entries) {
    const seq = seqs.get(path);
    if (seq !== undefined) {
      await store.mark(executionId, seq, stubOf(entry));
    }
  }
  await store.clear(executionId);
}

export async function readTrail(
  store: StepLedgerStore,
  executionIds: ReadonlyArray<string>,
): Promise<TrailMark[]> {
  const marks: TrailMark[] = [];
  for (const executionId of executionIds) {
    const kept = await store.trail(executionId);
    const live = [
      ...(await store.load(executionId)).entries.values(),
    ].map(stubOf);
    for (const mark of [
      ...kept,
      ...live,
    ]) {
      marks.push({
        executionId,
        ...mark,
      });
    }
  }
  return marks;
}
