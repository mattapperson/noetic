/**
 * What an ACP step keeps so a resumed run can go on with the agent's own session
 * instead of starting it over (spec 27 § Resuming a step).
 *
 * Two records, both beneath the step's place in the run:
 *
 * - The agent's session id, written when the step opens a session. A resumed step
 *   reloads that session (`session/load`) when the agent can.
 * - Each tool call the agent made through the bridge, written as it finishes. A
 *   resumed agent that makes the same call again gets the recorded result.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import type { Context, ContextData, Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';

import { stepPathOf } from '../connections/durability';
import { ContextImpl } from '../runtime/context-impl';
import { hashStepInput } from '../runtime/durable/step-ledger';
import type { ToolCallResult } from '../runtime/tool-call';
import { pendingEntryKey, runRootOf } from './connection-steps';

//#region Types

const AcpSessionRecordSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  /** How to reach the agent if it outlived the host that opened the session. */
  reattach: z.record(z.string(), z.unknown()).optional(),
  /**
   * What the session was opened with (`AcpSession.fingerprint`). Absent on a
   * record written before fingerprints were kept: such a session is accepted.
   */
  fingerprint: z.string().optional(),
  /**
   * The harness subprocess adapter the agent was started through, by name: a
   * reattach handle means something to that adapter only. Absent on a record
   * written before names were kept: such a handle is tried as it is.
   */
  subprocess: z.string().optional(),
});

/** The agent session a step opened, as stored. */
export type AcpSessionRecord = z.infer<typeof AcpSessionRecordSchema>;

/** The stored session of one step. */
export interface AcpSessionRecords {
  load(): Promise<AcpSessionRecord | undefined>;
  write(record: AcpSessionRecord): Promise<void>;
  clear(): Promise<void>;
}

const BridgedOutputSchema = z.object({
  output: z.string(),
  result: z.unknown().optional(),
  error: z.boolean().optional(),
});

/** One bridged call's place in the step's records. */
export interface BridgedCallRecord {
  /**
   * The call's id for anything that must survive a resume: its held record, a
   * durable tool's intent, its idempotency key. The agent's own id for the call
   * changes when the agent makes it again.
   */
  readonly id: string;
  /** The result an earlier attempt of the step recorded for this call. */
  take(): ToolCallResult | undefined;
  /** Record what the call produced. Resolves whether the record was stored. */
  store(result: ToolCallResult): Promise<boolean>;
}

/** The kind of a bridged call's ledger entry. */
const BRIDGED_KIND = 'acp-tool';

/**
 * @public
 * What a resumed ACP step tells the agent before its prompt, when it reloaded the
 * agent's session.
 */
export const ACP_RESUME_NOTICE =
  'Your previous turn on this task was cut off before it finished. Continue the task below from where you stopped. Do not redo work that is already done.';

//#endregion

//#region Helpers

interface HarnessWithStorage {
  config?: {
    storage?: StorageAdapter;
  };
}

function storageOf(ctx: Context<ContextData>): StorageAdapter | undefined {
  return frameworkCast<HarnessWithStorage>(ctx.harness).config?.storage;
}

function warn(action: string, key: string, error: unknown): void {
  console.warn(
    `acp step: failed to ${action} session record "${key}":`,
    error instanceof Error ? error.message : String(error),
  );
}

//#endregion

//#region Public API

/**
 * The session record of the ACP step running on `ctx`, or undefined when the run
 * is not durable: no ledger, no storage, or no place in the run.
 */
export function acpSessionRecords(ctx: Context<ContextData>): AcpSessionRecords | undefined {
  const storage = storageOf(ctx);
  const path = stepPathOf(ctx);
  const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
  if (!storage || !ledger || path === undefined) {
    return undefined;
  }
  // With the run's pending entries, so clearing the run clears it.
  const key = pendingEntryKey(runRootOf(ctx).id, `${path}/acp-session`);
  return {
    async load() {
      const parsed = AcpSessionRecordSchema.safeParse(await storage.get<unknown>(key));
      return parsed.success ? parsed.data : undefined;
    },
    async write(record) {
      if (!ledger.isHeld) {
        return;
      }
      await storage.set(key, record).catch((error: unknown) => warn('write', key, error));
    },
    async clear() {
      if (!ledger.isHeld) {
        return;
      }
      await storage.delete(key).catch((error: unknown) => warn('clear', key, error));
    },
  };
}

/**
 * Hands out the record of each bridged call of one step run. A call is known by
 * its tool, its arguments, and its place among the calls with that tool and those
 * arguments: a resumed agent's ids are new, but what it asks for is not.
 */
export class BridgedCallRecords {
  private readonly seen = new Map<string, number>();
  private reloaded = false;

  /**
   * The agent's session was reloaded: it has its own record of the calls it
   * finished, and was told not to redo them. A call it makes now is a new call,
   * even with a tool and arguments it used before, so it must not be answered
   * from a record. Each call's order starts after the ones already recorded.
   *
   * An agent that starts over in a new session makes its calls again from the
   * first, and those are answered from the record.
   */
  sessionReloaded(): void {
    this.reloaded = true;
  }

  recordFor(opts: {
    ctx: Context<ContextData>;
    stepId: string;
    tool: Tool | undefined;
    wireName: string;
    args: unknown;
  }): BridgedCallRecord {
    const { ctx, stepId, tool, wireName } = opts;
    const inputHash = hashStepInput({
      name: wireName,
      arguments: opts.args,
    });
    const step = stepPathOf(ctx) ?? stepId;
    const call = `${wireName}:${inputHash ?? 'unhashed'}`;
    const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
    const pathAt = (n: number): string => `${step}/bridged:${call}#${n}`;
    const key = `${step}\u0000${call}`;
    let order = this.seen.get(key);
    if (order === undefined) {
      order = 0;
      // Past what a reloaded agent already finished: those are not coming again.
      while (this.reloaded && ledger?.has(pathAt(order))) {
        order += 1;
      }
    }
    this.seen.set(key, order + 1);
    const path = pathAt(order);
    // `durable: false` records nothing; unhashable arguments cannot be matched.
    const records = ledger !== undefined && tool?.durable !== false && inputHash !== undefined;
    return {
      id: `acp:${path}`,
      take: () => {
        if (!records) {
          return undefined;
        }
        const entry = ledger.take(path, {
          id: stepId,
          kind: BRIDGED_KIND,
          inputHash,
        });
        const parsed = entry ? BridgedOutputSchema.safeParse(entry.output) : undefined;
        return parsed?.success ? parsed.data : undefined;
      },
      store: async (result) => {
        if (!records || result.held !== undefined) {
          return false;
        }
        if (tool?.durable === true) {
          ledger.noteEffect(path);
        }
        return ledger.record({
          path,
          stepId,
          kind: BRIDGED_KIND,
          inputHash,
          output: {
            output: result.output,
            ...(result.result === undefined
              ? {}
              : {
                  result: result.result,
                }),
            ...(result.error === undefined
              ? {}
              : {
                  error: result.error,
                }),
          },
          completedAt: new Date().toISOString(),
        });
      },
    };
  }
}

//#endregion
