/**
 * Workflow state memory layer and typed read/write helpers.
 *
 * The flow state is the single source of truth for top-level mode routing
 * (plan/act/verify/fix/done) plus approval and fix-loop bookkeeping. Every
 * `step.run` in the workflow reads state via `readFlowState` and writes via
 * `writeFlowState` + `persistFlowState`.
 */

import type { Context, ContextMemory, LLMResponse, MemoryLayer } from '@noetic-tools/core';
import { layerData, Slot } from '@noetic-tools/core/portable';
import { z } from 'zod';

//#region Types

/** @public Workflow state machine modes. */
export type CodeAgentMode = 'plan' | 'act' | 'verify' | 'fix' | 'done';

/** @public Question the plan agent stored when calling `requestPlanApproval`. */
export interface CodeAgentPlanApprovalQuestion {
  question: string;
  header: string;
}

/** @public Flow state persisted on the `code-agent-flow` memory layer. */
export interface CodeAgentFlowState {
  mode?: CodeAgentMode;
  awaitingPlanApproval?: boolean;
  approvalQuestion?: CodeAgentPlanApprovalQuestion;
  /** Fix-loop attempt counter. Caps at `maxFixAttempts` (default 3). */
  fixAttempts?: number;
  /** djb2 hash of the last verify findings — used to detect non-converging fix cycles. */
  lastFindingsHash?: string;
  /** The verify agent's findings, used to seed the fix agent's instructions. */
  verifyFindings?: string;
  /** The most recent user-visible text produced by act/verify/fix. Surfaces as `HarnessResponse.text` when mode → done. */
  lastUserText?: string;
  /** Diff line count captured at the start of the act phase; used to compute the act-phase delta. */
  actBaselineLines?: number;
  /** Set once any act iteration invokes a mutating tool (Edit/Write/Bash). Accumulates across the phase. */
  actDidMutateTools?: boolean;
  /** Diff line count captured at the start of the fix phase; used to compute the fix-phase delta. */
  fixBaselineLines?: number;
  /** Set once any fix iteration invokes a mutating tool. Accumulates across the phase. */
  fixDidMutateTools?: boolean;
}

//#endregion

//#region Constants

/** Layer id for the code-agent plan/act mode memory layer. */
export const CODE_AGENT_FLOW_LAYER_ID = 'code-agent-flow';

/** Zod schema for workflow state, used at the `ctx.memory` read boundary. */
export const CodeAgentFlowStateSchema: z.ZodType<CodeAgentFlowState> = z.object({
  mode: z
    .enum([
      'plan',
      'act',
      'verify',
      'fix',
      'done',
    ])
    .optional(),
  awaitingPlanApproval: z.boolean().optional(),
  approvalQuestion: z
    .object({
      question: z.string(),
      header: z.string(),
    })
    .optional(),
  fixAttempts: z.number().optional(),
  lastFindingsHash: z.string().optional(),
  verifyFindings: z.string().optional(),
  lastUserText: z.string().optional(),
  actBaselineLines: z.number().optional(),
  actDidMutateTools: z.boolean().optional(),
  fixBaselineLines: z.number().optional(),
  fixDidMutateTools: z.boolean().optional(),
});

/**
 * Empty LLMResponse used to trigger a `storeLayers` pass solely to persist
 * the flow-state mutation. The store hook reads from layer state, not from
 * this response, so the empty shape is inert.
 */
const EMPTY_STORE_RESPONSE: LLMResponse = {
  items: [],
  usage: {
    inputTokens: 0,
    outputTokens: 0,
  },
};

//#endregion

//#region Read / write / persist

/**
 * Typed, defensive read of the workflow state from `ctx.memory`. The layer
 * exposes `provides.state` as a `layerData` projection; parsing via
 * `CodeAgentFlowStateSchema` keeps the call site type-safe without reaching
 * into `ctx.harness.getLayerState` or casting the opaque memory handle.
 */
export function readFlowState(ctx: Context<ContextMemory>): CodeAgentFlowState {
  const handle = ctx.memory[CODE_AGENT_FLOW_LAYER_ID];
  const raw = handle?.state;
  const parsed = CodeAgentFlowStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Typed write that updates the workflow state via `ctx.harness.setLayerState`
 * — the sanctioned runtime API for step-level state writes (see spec 11).
 */
export function writeFlowState(ctx: Context<ContextMemory>, state: CodeAgentFlowState): void {
  ctx.harness.setLayerState<CodeAgentFlowState>(ctx.id, CODE_AGENT_FLOW_LAYER_ID, state);
}

/**
 * Flushes the current in-memory flow state to durable storage via the layer's
 * store hook. Required after any step mutates flow state — the containing
 * LLM's own storeLayers pass runs with the pre-mutation snapshot, so the
 * post-mutation value would otherwise be lost on the next turn's rehydrate.
 */
export async function persistFlowState(ctx: Context<ContextMemory>): Promise<void> {
  await ctx.harness.storeLayers(
    [
      flowMemory,
    ],
    EMPTY_STORE_RESPONSE,
    ctx,
  );
}

//#endregion

//#region Memory layer

/**
 * Mutable module-level default applied by `flowMemory.init` when no prior
 * state is persisted. Hosts (e.g. `@noetic-tools/cli`) call `setFlowMemoryDefaultMode`
 * before the first turn runs so fresh sessions boot in the right mode. The
 * legacy default stays `'plan'` so existing embedders retain plan-first
 * routing unless they opt in.
 */
let DEFAULT_INITIAL_MODE: CodeAgentMode = 'act';

/**
 * @public Set the default starting mode for fresh `flowMemory` sessions.
 * Called once at harness construction time by the host. No effect on sessions
 * whose state was already persisted.
 */
export function setFlowMemoryDefaultMode(mode: CodeAgentMode): void {
  DEFAULT_INITIAL_MODE = mode;
}

/**
 * Memory layer tracking the top-level workflow mode, outstanding approval
 * requests, and fix-loop bookkeeping. `provides.state` exposes a typed read
 * projection on `ctx.memory['code-agent-flow'].state`.
 */
export const flowMemory: MemoryLayer<CodeAgentFlowState> = {
  id: CODE_AGENT_FLOW_LAYER_ID,
  name: 'Code Agent Flow',
  // The mode advisory sits just above the steering slot so it is recalled
  // as steering context (ahead of working memory / observations) without
  // fighting built-in steering layers for the same slot.
  slot: Slot.STEERING + 5,
  scope: 'thread',
  provides: {
    state: layerData<CodeAgentFlowState, CodeAgentFlowState>({
      read: (state) => state,
    }),
  },
  hooks: {
    async init({ storage }) {
      const saved = await storage.get<CodeAgentFlowState>('state');
      return {
        state: saved ?? {
          mode: DEFAULT_INITIAL_MODE,
        },
      };
    },
    async recall({ state }) {
      const mode = state.mode ?? DEFAULT_INITIAL_MODE;
      const waiting = state.awaitingPlanApproval === true ? '\nAwaiting plan approval.' : '';
      return `<code_agent_flow mode="${mode}">${waiting}</code_agent_flow>`;
    },
    async store({ state }) {
      return {
        state,
      };
    },
    async onSpawn({ parentState }) {
      return {
        childState: {
          ...parentState,
        },
      };
    },
    async onReturn({ childState, parentState }) {
      // Propagate only the known flow fields, and only when the child actually
      // set them. Spawned plan agents need to flip mode plan → act after
      // approval, so the child's assignment wins when defined — but an
      // exploration teammate that never touched the flow state shouldn't
      // erase anything the parent set in the meantime.
      return {
        parentState: {
          ...parentState,
          ...(childState.mode !== undefined && {
            mode: childState.mode,
          }),
          ...(childState.awaitingPlanApproval !== undefined && {
            awaitingPlanApproval: childState.awaitingPlanApproval,
          }),
          ...(childState.approvalQuestion !== undefined && {
            approvalQuestion: childState.approvalQuestion,
          }),
          ...(childState.fixAttempts !== undefined && {
            fixAttempts: childState.fixAttempts,
          }),
          ...(childState.lastFindingsHash !== undefined && {
            lastFindingsHash: childState.lastFindingsHash,
          }),
          ...(childState.verifyFindings !== undefined && {
            verifyFindings: childState.verifyFindings,
          }),
          ...(childState.lastUserText !== undefined && {
            lastUserText: childState.lastUserText,
          }),
          ...(childState.actBaselineLines !== undefined && {
            actBaselineLines: childState.actBaselineLines,
          }),
          ...(childState.actDidMutateTools !== undefined && {
            actDidMutateTools: childState.actDidMutateTools,
          }),
          ...(childState.fixBaselineLines !== undefined && {
            fixBaselineLines: childState.fixBaselineLines,
          }),
          ...(childState.fixDidMutateTools !== undefined && {
            fixDidMutateTools: childState.fixDidMutateTools,
          }),
        },
      };
    },
  },
};

//#endregion
