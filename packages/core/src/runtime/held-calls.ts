/**
 * Held tool calls: a call left open for a person (spec 08 § Held tool calls).
 *
 * A call is held when the approver answers `hold`, when a tool that needs
 * approval has no approver, or when a tool returns `hold()` in place of a
 * result. Nothing is written to the conversation for it. Its record sits in
 * storage until `harness.resolve()` settles it; then the round walks its calls
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
  /** `approval`: the tool has not run. `result`: it ran and left its result open. */
  reason: z.enum([
    'approval',
    'result',
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
    if ((record.reason === 'result') !== (resolution.hasOutput === true)) {
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

  /**
   * Resolves once something about the execution's held calls changed, `untilMs`
   * from now passed, or `signal` aborted. The caller then looks again.
   */
  wait(executionId: string, untilMs: number | undefined, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(executionId) ?? new Set<() => void>();
      this.waiters.set(executionId, waiters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        waiters.delete(done);
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener('abort', done, {
        once: true,
      });
      if (untilMs !== undefined) {
        timer = setTimeout(done, Math.max(0, untilMs));
      }
      if (signal.aborted) {
        done();
      }
    });
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
}): Promise<void> {
  const { ctx } = opts;
  const holds = heldCallsOf(opts.harness);
  const executionId = heldScopeOf(ctx);
  let earliest = Number.POSITIVE_INFINITY;
  for (const callId of opts.callIds) {
    const record = await holds.load(executionId, callId);
    // An answer that landed since the call was looked at: do not wait at all.
    if (!record || record.resolution) {
      return;
    }
    if (record.dueAt !== undefined && record.onDue !== 'keep') {
      earliest = Math.min(earliest, record.dueAt);
    }
  }
  const impl = ctx instanceof ContextImpl ? ctx : undefined;
  const signal = impl?.abortSignal ?? opts.signal ?? new AbortController().signal;
  const stopWaiting = impl?.ledger?.parking.wait(impl.currentDispatch()?.path, earliest);
  try {
    await holds.wait(
      executionId,
      Number.isFinite(earliest) ? earliest - holds.now() : undefined,
      signal,
    );
  } finally {
    stopWaiting?.();
  }
  if (signal.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: ctx.abortReason ?? 'context aborted',
    });
  }
}

/** True once a hold with a `deny` deadline has run out. */
export function isOverdue(record: HeldRecord, now: number): boolean {
  return record.dueAt !== undefined && record.onDue !== 'keep' && record.dueAt <= now;
}

//#endregion
