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
    const order = this.seen.get(`${step}\u0000${call}`) ?? 0;
    this.seen.set(`${step}\u0000${call}`, order + 1);
    const path = `${step}/bridged:${call}#${order}`;
    const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
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
