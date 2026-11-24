/**
 * Held tool calls: a call left open for a person (spec 08 § Held tool calls).
 *
 * A call is held when the approver answers `hold`, when a tool that needs
 * approval has no approver, or when a tool returns `hold()` in place of a
 * result. Nothing is written to the conversation for it. Its record sits in
 * storage until a decision passed to `harness.execute()` settles it; then the round walks its calls
 * again, and this time the call has an answer.
 *
 * The record is the whole state, so a held call survives the process: a parked
 * turn resumed on another harness finds the same record and the same answer.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import type { Context, HeldCall, HeldResolution, ToolApprover } from '@noetic-tools/types';
import { NoeticErrorImpl } from '@noetic-tools/types';
import { z } from 'zod';
import { ContextImpl, rootIdOf } from './context-impl';
import { hashStepInput } from './durable/step-ledger';
import { createInMemoryStorage } from './in-memory-storage';

//#region Types

const ResolutionSchema = z.object({
  /** An approval's answer. */
  action: z
    .enum([
      'allow',
      'deny',
      'guide',
    ])
    .optional(),
  guidance: z.string().optional(),
  /** A held result's value. Present, even as `null`, when `hasOutput` is set. */
  output: z.unknown().optional(),
  hasOutput: z.boolean().optional(),
});

const HeldRecordSchema = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
  /** Hash of the call's name and arguments: an answer is for this call and no other. */
  argsHash: z.string(),
  /** Why the call is held: see `HeldCall.reason`. */
  reason: z.enum([
    'approval',
    'result',
    'outcome',
  ]),
  dueAt: z.number().optional(),
  onDue: z
    .enum([
      'deny',
      'keep',
    ])
    .optional(),
  /** Passed back by a tool's `hold()`, for whoever answers. */
  request: z.unknown().optional(),
  resolution: ResolutionSchema.optional(),
});

/** @internal A held call as stored. */
export type HeldRecord = z.infer<typeof HeldRecordSchema>;

/** @internal What held calls need of a harness: where to keep them, and its clock. */
export interface HoldHost {
  readonly config: {
    readonly name: string;
    readonly storage?: StorageAdapter;
    readonly now?: () => number;
    readonly approveToolCall?: ToolApprover;
  };
}

/** @internal How long a hold lasts and what happens when that runs out. */
export interface HoldDue {
  dueAt?: number;
  onDue?: 'deny' | 'keep';
}

/**
 * @internal
 * Thrown by an approval seam to say "hold this call". Caught where the call's
 * record can be written; never reaches a caller of the harness.
 */
export class HoldSignal extends Error {
  constructor(readonly due: HoldDue = {}) {
    super('The tool call is held for a person.');
    this.name = 'HoldSignal';
  }
}

//#endregion

//#region Helpers

/** The hash that ties an answer to one call: its tool name and arguments. */
export function heldArgsHash(name: string, args: unknown): string {
  return (
    hashStepInput({
      name,
      args,
    }) ?? ''
  );
}

const IntentSchema = z.object({
  argsHash: z.string(),
});

function intentPrefix(executionId: string): string {
  return `execution:${executionId}:intent:`;
}

/** How often a live turn re-reads held calls that another process may have answered. */
const HELD_POLL_MS = 2e3;

function heldPrefix(executionId: string): string {
  return `execution:${executionId}:held:`;
}

function refused(callId: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'hold_refused',
    callId,
    reason,
  });
}

function sameResolution(a: HeldRecord['resolution'], b: HeldRecord['resolution']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toResolutionRecord(resolution: HeldResolution): NonNullable<HeldRecord['resolution']> {
  if ('action' in resolution) {
    return {
      action: resolution.action,
      ...(resolution.guidance === undefined
        ? {}
        : {
            guidance: resolution.guidance,
          }),
    };
  }
  return {
    output: resolution.output,
    hasOutput: true,
  };
}

/** A held record as hosts see it. */
export function toHeldCall(record: HeldRecord): HeldCall {
  return {
    callId: record.callId,
    name: record.name,
    args: record.args,
    argsHash: record.argsHash,
    reason: record.reason,
    ...(record.dueAt === undefined
      ? {}
      : {
          dueAt: record.dueAt,
        }),
    ...(record.onDue === undefined
      ? {}
      : {
          onDue: record.onDue,
        }),
    ...(record.request === undefined
      ? {}
      : {
          request: record.request,
        }),
  };
}

//#endregion

//#region HeldCalls

/** @internal One harness's held calls: their records, and who is waiting on them here. */
export class HeldCalls {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly clock: () => number,
  ) {}

  now(): number {
    return this.clock();
  }

  /** The record of `callId`, when the call is held. */
  async load(executionId: string, callId: string): Promise<HeldRecord | undefined> {
    const raw = await this.storage.get<unknown>(`${heldPrefix(executionId)}${callId}`);
    const parsed = raw === null ? undefined : HeldRecordSchema.safeParse(raw);
    return parsed?.success ? parsed.data : undefined;
  }

  /** Every held call of an execution. */
  async list(executionId: string): Promise<HeldRecord[]> {
    const found: HeldRecord[] = [];
    for (const key of await this.storage.list(heldPrefix(executionId))) {
      const parsed = HeldRecordSchema.safeParse(await this.storage.get<unknown>(key));
      if (parsed.success) {
        found.push(parsed.data);
      }
    }
    return found;
  }

  /** Hold a call. A call already held keeps its record, and with it any answer. */
  async open(executionId: string, record: HeldRecord): Promise<HeldRecord> {
    const existing = await this.load(executionId, record.callId);
    if (existing && existing.argsHash === record.argsHash) {
      return existing;
    }
    await this.storage.set(`${heldPrefix(executionId)}${record.callId}`, record);
    return record;
  }

  /** Drop every held call and intent of an execution that is over or was abandoned. */
  async clear(executionId: string): Promise<void> {
    for (const prefix of [
      heldPrefix(executionId),
      intentPrefix(executionId),
    ]) {
      for (const key of await this.storage.list(prefix)) {
        await this.storage.delete(key);
      }
    }
  }

  /**
   * Note that a `durable` tool call is about to run. Written before the tool does
   * anything, so a resumed run that finds it knows the call had started.
   */
  async arm(executionId: string, callId: string, argsHash: string): Promise<void> {
    await this.storage.set(`${intentPrefix(executionId)}${callId}`, {
      argsHash,
    });
  }

  /** True when a call with these arguments was started and never finished. */
  async wasStarted(executionId: string, callId: string, argsHash: string): Promise<boolean> {
    const raw = await this.storage.get<unknown>(`${intentPrefix(executionId)}${callId}`);
    const parsed = IntentSchema.safeParse(raw);
    return parsed.success && parsed.data.argsHash === argsHash;
  }

  /** The call finished and its result is on record. */
  async disarm(executionId: string, callId: string): Promise<void> {
    await this.storage.delete(`${intentPrefix(executionId)}${callId}`);
  }

  /** The call was settled and its result recorded: drop its record. */
  async close(executionId: string, callId: string): Promise<void> {
    await this.storage.delete(`${heldPrefix(executionId)}${callId}`);
  }

  /**
   * Answer a held call. The first answer wins: the same answer again is a no-op, a
   * different one is refused.
   *
   * @throws NoeticError `hold_refused` when the call is not held, `argsHash` names a
   *   different call, the answer is the wrong kind for the hold, or another answer
   *   already landed.
   */
  async resolve(
    executionId: string,
    answer: {
      callId: string;
      argsHash?: string;
      resolution: HeldResolution;
    },
  ): Promise<void> {
    const { callId } = answer;
    const record = await this.load(executionId, callId);
    if (!record) {
      throw refused(callId, 'no call with this id is held');
    }
    if (answer.argsHash !== undefined && answer.argsHash !== record.argsHash) {
      throw refused(callId, 'the answer is for a call with different arguments');
    }
    const resolution = toResolutionRecord(answer.resolution);
    // An unknown outcome takes either answer: "it landed, here is the result", or
    // a decision on whether to run it again.
    const wrongKind =
      record.reason !== 'outcome' &&
      (record.reason === 'result') !== (resolution.hasOutput === true);
    if (wrongKind) {
      throw refused(
        callId,
        record.reason === 'result'
          ? 'the call waits for a result, not an approval'
          : 'the call waits for an approval, not a result',
      );
    }
    if (record.resolution) {
      if (sameResolution(record.resolution, resolution)) {
        return;
      }
      throw refused(callId, 'the call was already answered differently');
    }
    const next: HeldRecord = {
      ...record,
      resolution,
    };
    const key = `${heldPrefix(executionId)}${callId}`;
    // With compare-and-set, two answers racing from two processes cannot both land.
    const landed = this.storage.swap ? await this.storage.swap(key, record, next) : true;
    if (!this.storage.swap) {
      await this.storage.set(key, next);
    }
    if (!landed) {
      const now = await this.load(executionId, callId);
      if (now?.resolution && sameResolution(now.resolution, resolution)) {
        return;
      }
      throw refused(callId, 'the call was already answered differently');
    }
    this.notify(executionId);
  }

  /** True when other processes may share this storage, and so may answer a call. */
  get shared(): boolean {
    return this.storage.swap !== undefined;
  }

  /**
   * Start listening for a change to the execution's held calls. Listening begins
   * when this returns, so an answer that lands while the caller is still reading
   * the records is not missed. `changed` resolves on the first change or when
   * `signal` aborts; call `stop` when done either way.
   */
  listen(
    executionId: string,
    signal: AbortSignal,
  ): {
    changed: Promise<void>;
    stop: () => void;
  } {
    const waiters = this.waiters.get(executionId) ?? new Set<() => void>();
    this.waiters.set(executionId, waiters);
    let wake: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const stop = (): void => {
      waiters.delete(wake);
      signal.removeEventListener('abort', wake);
    };
    waiters.add(wake);
    signal.addEventListener('abort', wake, {
      once: true,
    });
    if (signal.aborted) {
      wake();
    }
    return {
      changed,
      stop,
    };
  }

  /** Wake whoever in this process waits on the execution's held calls. */
  notify(executionId: string): void {
    for (const wake of [
      ...(this.waiters.get(executionId) ?? []),
    ]) {
      wake();
    }
  }
}

const stores = new WeakMap<object, HeldCalls>();

/** @internal The held calls of `harness`, over its storage and clock. */
export function heldCallsOf(harness: HoldHost): HeldCalls {
  const existing = stores.get(harness);
  if (existing) {
    return existing;
  }
  const created = new HeldCalls(
    harness.config.storage ?? createInMemoryStorage(),
    () => harness.config.now?.() ?? Date.now(),
  );
  stores.set(harness, created);
  return created;
}

/** @internal The execution a context's held calls are kept under: its root. */
export function heldScopeOf(ctx: Context): string {
  return rootIdOf(ctx);
}

/**
 * @internal
 * Wait until something about these held calls may have changed: an answer arrived,
 * or a hold's deadline passed. While it waits the step is only waiting, so the
 * turn may park (spec 23 § Parked turns).
 *
 * @throws NoeticError `cancelled` when the context is aborted, which is also how a
 *   parked turn leaves here.
 */
export async function waitOnHeldCalls(opts: {
  harness: HoldHost;
  ctx: Context;
  callIds: ReadonlyArray<string>;
  /** Used when `ctx` carries no abort signal of its own. */
  signal?: AbortSignal;
  /** False when the turn must stay live while it waits. Default true. */
  park?: boolean;
}): Promise<void> {
  const { ctx } = opts;
  const holds = heldCallsOf(opts.harness);
  const executionId = heldScopeOf(ctx);
  const impl = ctx instanceof ContextImpl ? ctx : undefined;
  const signal = impl?.abortSignal ?? opts.signal ?? new AbortController().signal;
  // Listen before reading: an answer that lands in between must still wake this.
  const listening = holds.listen(executionId, signal);
  let stopWaiting: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let earliest = Number.POSITIVE_INFINITY;
    for (const callId of opts.callIds) {
      const record = await holds.load(executionId, callId);
      if (!record || record.resolution) {
        return;
      }
      if (record.dueAt !== undefined && record.onDue !== 'keep') {
        earliest = Math.min(earliest, record.dueAt);
      }
    }
    stopWaiting =
      opts.park === false
        ? undefined
        : impl?.ledger?.parking.wait(impl.currentDispatch()?.path, earliest);
    // Another process answering cannot wake this one, so shared storage is read again
    // every so often. A deadline wakes it too.
    const untilDue = earliest - holds.now();
    const wakeIn = Math.min(untilDue, holds.shared ? HELD_POLL_MS : Number.POSITIVE_INFINITY);
    await Promise.race([
      listening.changed,
      new Promise<void>((resolve) => {
        if (Number.isFinite(wakeIn)) {
          timer = setTimeout(resolve, Math.max(0, wakeIn));
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    stopWaiting?.();
    listening.stop();
  }
  if (signal.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }
}

/**
 * @internal
 * False once the context's execution writes under a lease it no longer holds: a
 * harness that was replaced must not open, close or disarm the new holder's calls
 * (spec 23 § One writer per turn). An answer (`resolve`) is not a turn's write and
 * is not fenced; it is a compare-and-set any harness may make.
 */
export function mayWriteHolds(ctx: Context): boolean {
  let node: Context = ctx;
  while (node.parent) {
    node = node.parent;
  }
  for (const candidate of [
    ctx,
    node,
  ]) {
    if (candidate instanceof ContextImpl && candidate.ledger) {
      return candidate.ledger.isHeld;
    }
  }
  return true;
}

/** @internal How a call held by `holdAndWait` ended. */
export interface HeldAnswer {
  /** The answer, or undefined when the hold's deadline passed with none. */
  resolution: HeldRecord['resolution'];
}

/**
 * @internal
 * Hold a call from a caller with no model round to come back to (a step), and wait
 * for its answer. While it waits the step is only waiting, so the turn may park; a
 * resumed step calls this again and finds the same record, and its answer.
 *
 * @throws NoeticError `cancelled` when the context is aborted while it waits.
 */
export async function holdAndWait(opts: {
  harness: HoldHost;
  ctx: Context;
  record: HeldRecord;
  /** Called once per process, when the call is first seen held. */
  onHeld?: (held: HeldCall) => void;
}): Promise<HeldAnswer> {
  const holds = heldCallsOf(opts.harness);
  const executionId = heldScopeOf(opts.ctx);
  const { callId } = opts.record;
  const opened = mayWriteHolds(opts.ctx) ? await holds.open(executionId, opts.record) : opts.record;
  opts.onHeld?.(toHeldCall(opened));
  for (;;) {
    const current = await holds.load(executionId, callId);
    const settled = current?.resolution !== undefined;
    if (!current || settled || isOverdue(current, holds.now())) {
      if (mayWriteHolds(opts.ctx)) {
        await holds.close(executionId, callId);
      }
      return {
        resolution: current?.resolution,
      };
    }
    await waitOnHeldCalls({
      harness: opts.harness,
      ctx: opts.ctx,
      callIds: [
        callId,
      ],
    });
  }
}

/** True once a hold with a `deny` deadline has run out. */
export function isOverdue(record: HeldRecord, now: number): boolean {
  return record.dueAt !== undefined && record.onDue !== 'keep' && record.dueAt <= now;
}

//#endregion
