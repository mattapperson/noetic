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
import type {
  AcpContentBlock,
  Context,
  ContextData,
  SteeringDecision,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import { z } from 'zod';

import { stepPathOf } from '../connections/durability';
import { ContextImpl } from '../runtime/context-impl';
import { TURN_CUT_ABORT } from '../runtime/durable/parking';
import { StepIntent } from '../runtime/durable/step-intent';
import type { StepLedger } from '../runtime/durable/step-ledger';
import { hashStepInput } from '../runtime/durable/step-ledger';
import type { ToolCallResult } from '../runtime/tool-call';
import { pendingEntryKey, runRootOf } from './connection-steps';

//#region Types

const AcpSessionRecordSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  /** Written before the first prompt. Older records precede this guarantee. */
  sent: z.literal(true).optional(),
  promptId: z.string().optional(),
  guidance: z.string().optional(),
  bridgePath: z.string().optional(),
  /** Guidance prompts written before this flag shared the step's call records. */
  scopedCalls: z.literal(true).optional(),
  stableCalls: z.literal(true).optional(),
  steering: z.number().int().nonnegative().optional(),
  promptHash: z.string().optional(),
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
  decide(
    promptId: string,
    run: () => Promise<SteeringDecision | undefined>,
  ): Promise<SteeringDecision | undefined>;
}

const SteeringRecord = z.object({
  decided: z.literal(true),
  decision: z
    .object({
      action: z.enum([
        'allow',
        'deny',
        'guide',
        'hold',
      ]),
      guidance: z.string().optional(),
      dueAt: z.number().optional(),
      onDue: z
        .enum([
          'deny',
          'keep',
        ])
        .optional(),
    })
    .optional(),
});

const BridgedOutputSchema = z.object({
  agentCallId: z.string().optional(),
  prompt: z.number().int().nonnegative().optional(),
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

//#endregion

//#region Public API

/** Check the previously dispatched prompt before opening or attaching to a session. */
export async function acpRecovery({
  ctx,
  stepId,
  agentId,
  ledgerKey,
  subprocess,
  prompt,
}: {
  ctx: Context<ContextData>;
  stepId: string;
  agentId: string;
  ledgerKey: string | undefined;
  subprocess: string | undefined;
  prompt: {
    text: string;
    blocks: ReadonlyArray<AcpContentBlock> | undefined;
  };
}) {
  const sessions = acpSessionRecords(ctx, ledgerKey);
  const recorded = await sessions?.load();
  const impl = ctx instanceof ContextImpl ? ctx : undefined;
  const position = impl?.currentPath();
  const promptHash = hashStepInput(prompt);
  if (
    recorded &&
    (recorded.agentId !== agentId ||
      (recorded.promptHash !== undefined && recorded.promptHash !== promptHash))
  ) {
    throw new NoeticErrorImpl({
      kind: 'acp_outcome_unknown',
      stepId,
      sessionId: recorded.sessionId,
    });
  }
  if (
    recorded?.reattach &&
    recorded.subprocess !== undefined &&
    recorded.subprocess !== subprocess
  ) {
    throw movedAgent(
      stepId,
      recorded.subprocess,
      subprocess ?? ctx.adapters.subprocess.defaultName,
    );
  }
  const bridgePath =
    recorded?.bridgePath ??
    (!recorded && ledgerKey !== undefined && ledgerKey !== position
      ? 'acp-tools:' + hashStepInput(ledgerKey)
      : position);
  return {
    sessions,
    recorded,
    ledger: impl?.ledger,
    position,
    bridgePath,
    promptHash,
  };
}

export function wasCut(ctx: Context<ContextData>): boolean {
  return ctx.abortReason === TURN_CUT_ABORT;
}

/**
 * The session record of the ACP step running on `ctx`, or undefined when the run
 * is not durable: no ledger, no storage, or no place in the run.
 */
export function acpSessionRecords(
  ctx: Context<ContextData>,
  path: string | undefined,
): AcpSessionRecords | undefined {
  const storage = storageOf(ctx);
  const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
  if (!storage || !ledger || path === undefined) {
    return undefined;
  }
  // With the run's pending entries, so clearing the run clears it.
  const executionId = runRootOf(ctx).id;
  const positional = stepPathOf(ctx);
  const intent = new StepIntent(
    storage,
    pendingEntryKey(executionId, `${path}/acp-session`),
    ledger,
  );
  return {
    async load() {
      const prior = await intent.read();
      if (prior === null && positional !== undefined && positional !== path) {
        const local = new StepIntent(
          storage,
          pendingEntryKey(executionId, `${positional}/acp-session`),
        );
        if (
          (await local.read()) !== null ||
          (ledger.mayHavePending && (await hasOtherSession(storage, executionId, positional)))
        ) {
          throw new NoeticErrorImpl({
            kind: 'acp_outcome_unknown',
            stepId: path,
          });
        }
      }
      const parsed = AcpSessionRecordSchema.safeParse(prior);
      if (prior !== null && !parsed.success) {
        throw new NoeticErrorImpl({
          kind: 'acp_outcome_unknown',
          stepId: path,
        });
      }
      return parsed.success ? parsed.data : undefined;
    },
    async decide(promptId, run) {
      const decision = new StepIntent(
        storage,
        pendingEntryKey(executionId, `${path}/steering:${promptId}`),
        ledger,
      );
      const stored = await decision.read();
      if (stored !== null) {
        const parsed = SteeringRecord.safeParse(stored);
        if (!parsed.success) {
          throw new NoeticErrorImpl({
            kind: 'acp_outcome_unknown',
            stepId: path,
          });
        }
        return parsed.data.decision;
      }
      await decision.write({
        deciding: true,
      });
      const result = await run();
      await decision.write({
        decided: true,
        decision: result,
      });
      return result;
    },
    async clear() {
      await intent.clear().catch(() => undefined);
    },
    async write(record) {
      await intent.write(record);
    },
  };
}

/** Match a redelivered bridge request to the original call when the keeper reconnects. */
export class BridgedCallRecords {
  private readonly seen = new Map<string, number>();
  private mode: 'fresh' | 'resume' | 'legacy' = 'fresh';
  private path?: string;
  private prompt?: number;

  bind(path: string | undefined, mode: 'fresh' | 'resume' | 'legacy', prompt?: number): void {
    this.mode = mode;
    this.path = path;
    this.prompt = prompt;
    this.seen.clear();
  }

  async recordFor(opts: {
    ctx: Context<ContextData>;
    stepId: string;
    tool: Tool | undefined;
    wireName: string;
    agentCallId?: string;
    args: unknown;
  }): Promise<BridgedCallRecord> {
    const { ctx, stepId, tool, wireName, agentCallId } = opts;
    const inputHash = hashStepInput({
      name: wireName,
      arguments: opts.args,
    });
    const step = this.path ?? stepPathOf(ctx) ?? stepId;
    const prompt = this.prompt;
    const scope = prompt === undefined ? step : `${step}/prompt:${prompt}`;
    const call = `${wireName}:${inputHash ?? 'unhashed'}`;
    const ledger = ctx instanceof ContextImpl ? ctx.ledger : undefined;
    const pathAt = (n: number): string => `${scope}/bridged:${call}#${n}`;
    let order = this.seen.get(call) ?? 0;
    const prior =
      this.mode !== 'fresh' && ledger && tool?.durable !== false
        ? this.savedPath({
            ledger,
            step,
            scope,
            stepId,
            agentCallId,
            inputHash,
          })
        : undefined;
    while (
      prior === undefined &&
      this.mode !== 'fresh' &&
      tool?.durable !== false &&
      ledger?.has(pathAt(order))
    ) {
      order += 1;
    }
    // Keep stable IDs at the step path so a reused ID cannot execute twice.
    const stable =
      agentCallId === undefined ? undefined : `${step}/bridged:id:${hashStepInput(agentCallId)}`;
    if (prior === undefined && stable === undefined) {
      this.seen.set(call, order + 1);
    }
    const path = prior ?? stable ?? pathAt(order);
    // `durable: false` records nothing; unhashable arguments cannot be matched.
    const records = ledger !== undefined && tool?.durable !== false && inputHash !== undefined;
    if (records && !prior) {
      await this.bindInput({
        ctx,
        ledger,
        step,
        path,
        anonymous: pathAt(order),
        stable: stable !== undefined,
        inputHash,
        stepId,
      });
    }
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
            ...(prompt === undefined
              ? {}
              : {
                  prompt,
                }),
            ...(agentCallId === undefined
              ? {}
              : {
                  agentCallId,
                }),
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

  private async bindInput({
    ctx,
    ledger,
    step,
    path,
    anonymous,
    stable,
    inputHash,
    stepId,
  }: {
    ctx: Context<ContextData>;
    ledger: StepLedger;
    step: string;
    path: string;
    anonymous: string;
    stable: boolean;
    inputHash: string;
    stepId: string;
  }): Promise<void> {
    const storage = storageOf(ctx);
    if (!storage) {
      return;
    }
    const intent = (path: string) =>
      new StepIntent(storage, pendingEntryKey(runRootOf(ctx).id, `${path}/tool`), ledger);
    const identity = intent(path);
    const saved = await identity.read();
    if (!stable && this.mode !== 'fresh') {
      const prefix = pendingEntryKey(runRootOf(ctx).id, `${step}/bridged:id:`);
      for (const key of await storage.list(prefix)) {
        if (!key.endsWith('/tool')) {
          continue;
        }
        const other = await new StepIntent(storage, key).read();
        if (
          other &&
          typeof other === 'object' &&
          Reflect.get(other, 'prompt') === this.prompt &&
          Reflect.get(other, 'inputHash') === inputHash
        ) {
          throw new NoeticErrorImpl({
            kind: 'acp_outcome_unknown',
            stepId,
          });
        }
      }
    }
    if (
      saved === null &&
      (this.mode === 'fresh' || !stable || (await intent(anonymous).read()) === null)
    ) {
      await identity.write({
        inputHash,
        ...(this.prompt === undefined
          ? {}
          : {
              prompt: this.prompt,
            }),
      });
      return;
    }
    if (
      stable &&
      typeof saved === 'object' &&
      saved !== null &&
      Reflect.get(saved, 'prompt') === this.prompt &&
      Reflect.get(saved, 'inputHash') === inputHash
    ) {
      return;
    }
    throw new NoeticErrorImpl({
      kind: 'acp_outcome_unknown',
      stepId,
    });
  }

  private savedPath({
    ledger,
    step,
    scope,
    stepId,
    agentCallId,
    inputHash,
  }: {
    ledger: StepLedger;
    step: string;
    scope: string;
    stepId: string;
    agentCallId?: string;
    inputHash?: string;
  }): string | undefined {
    const root = `${step}/bridged:`;
    const active = `${scope}/bridged:`;
    const prefixes = [
      root,
      active,
    ];
    let unmatched = false;
    for (const entry of ledger.savedEntries()) {
      if (
        entry.kind !== BRIDGED_KIND ||
        !prefixes.some(
          (prefix) =>
            entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'),
        )
      ) {
        continue;
      }
      const saved = BridgedOutputSchema.safeParse(entry.output);
      const id = saved.success ? saved.data.agentCallId : undefined;
      const samePrompt = saved.success
        ? saved.data.prompt === this.prompt
        : entry.path.startsWith(active);
      if (agentCallId !== undefined && id === agentCallId) {
        if (!samePrompt || entry.inputHash !== inputHash) {
          throw new NoeticErrorImpl({
            kind: 'acp_outcome_unknown',
            stepId,
          });
        }
        return entry.path;
      }
      unmatched ||=
        samePrompt &&
        entry.inputHash === inputHash &&
        (agentCallId === undefined || id === undefined);
    }
    if (unmatched || this.mode === 'legacy') {
      throw new NoeticErrorImpl({
        kind: 'acp_outcome_unknown',
        stepId,
      });
    }
    return undefined;
  }
}

function movedAgent(stepId: string, started: string, now: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'ACP_SESSION_ADAPTER_CONFLICT',
    message: `step.acpAgent(${JSON.stringify(stepId)}) resumes an agent started through the subprocess adapter '${started}', but now runs through '${now}'.`,
    hint: `Resume with the step, its agent and \`environment.subprocess\` resolving to '${started}', as in the run that started the agent.`,
  });
}

/** A keyed step cannot prove whether a positional intent from another lane is its own. */
async function hasOtherSession(
  storage: StorageAdapter,
  executionId: string,
  position: string,
): Promise<boolean> {
  const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/#\d+$/, '');
  const prefix = pendingEntryKey(executionId, '/');
  const suffix = '/acp-session';
  for (const key of await storage.list(prefix)) {
    if (key.endsWith(suffix) && leaf(key.slice(0, -suffix.length)) === leaf(position)) {
      if ((await new StepIntent(storage, key).read()) !== null) {
        return true;
      }
    }
  }
  return false;
}

//#endregion
