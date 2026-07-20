import type { MemoryLayer, MemoryScope } from '@noetic-tools/types';
import { createMessage, estimateTokens, Slot, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import type { FlowNode } from '../flow-schema';
import { FlowSchema, flowDepth } from '../flow-schema';
import { layerData, layerFn } from '../layer-provides';

//#region Constants

const MAX_PRD_LENGTH = 5e4;
const MAX_TREE_DEPTH = 5;
const MAX_EXECUTION_LOG_ENTRIES = 10;
const PLAN_SLOT = Slot.PROCEDURAL - 10; // 240

const ALLOWED_TOOLS_IN_PLAN_MODE = new Set([
  'Read',
  'Grep',
  'Find',
  'Ls',
  'AskUserQuestion',
  'activateSkill',
  'agent',
  'checkAgent',
  'sendMessage',
  'requestPlanApproval',
  'plan/enterPlanMode',
  'plan/updatePrd',
  'plan/setPlanTree',
  'plan/exitPlanMode',
]);

//#endregion

//#region Types

export const PlanPhase = {
  Idle: 'idle',
  Planning: 'planning',
  Executing: 'executing',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type PlanPhase = (typeof PlanPhase)[keyof typeof PlanPhase];

export interface PlanExecutionEntry {
  timestamp: number;
  version: number;
  outcome: 'success' | 'failure' | 'aborted';
}

export interface PlanState {
  phase: PlanPhase;
  prd: string | null;
  planTree: FlowNode | null;
  executionLog: PlanExecutionEntry[];
  version: number;
  /** Identifier of the on-disk plan session (set by `onEnterSession` host callback). */
  planSlug?: string | null;
}

/** Host-supplied callback invoked when entering plan mode. Returns a session identifier the host owns (e.g. on-disk dir slug). */
export type PlanEnterSessionCallback = () => Promise<{
  slug: string;
}>;

/**
 * Host-supplied callback invoked when the model requests `exitPlanMode` with `action: 'execute'`.
 * Return `{ approved: false }` to keep the layer in `Planning` (e.g. user rejected the plan in the UI).
 */
export type PlanExitCallback = (state: PlanState) => Promise<{
  approved: boolean;
}>;

export interface PlanMemoryConfig {
  scope?: MemoryScope;
  additionalAllowedTools?: string[];
  maxPrdLength?: number;
  maxTreeDepth?: number;
  /** Extra free-form instructions appended to the planning-phase recall payload. */
  additionalPlanInstructions?: string;
  /** Called once when the layer transitions Idle → Planning. */
  onEnterSession?: PlanEnterSessionCallback;
  /** Called when `exitPlanMode` is requested with `action: 'execute'`. */
  onExit?: PlanExitCallback;
}

//#endregion

//#region Helpers

function createDefaultState(): PlanState {
  return {
    phase: PlanPhase.Idle,
    prd: null,
    planTree: null,
    executionLog: [],
    version: 0,
  };
}

function validateTreeDepth(node: FlowNode, maxDepth: number): boolean {
  return flowDepth(node) <= maxDepth;
}

function buildAllowedTools(config?: PlanMemoryConfig): Set<string> {
  if (!config?.additionalAllowedTools?.length) {
    return ALLOWED_TOOLS_IN_PLAN_MODE;
  }
  return new Set([
    ...ALLOWED_TOOLS_IN_PLAN_MODE,
    ...config.additionalAllowedTools,
  ]);
}

function trimExecutionLog(log: PlanExecutionEntry[]): PlanExecutionEntry[] {
  if (log.length <= MAX_EXECUTION_LOG_ENTRIES) {
    return log;
  }
  return log.slice(log.length - MAX_EXECUTION_LOG_ENTRIES);
}

//#endregion

//#region Recall Renderers

function recallPlanning(state: PlanState, additionalInstructions?: string): string {
  const sections: string[] = [
    '<plan_mode>',
    'You are in PLAN MODE. You may only use read-only tools (Read, Grep, Find, Ls), AskUserQuestion, skill activation, sub-agent coordination tools, and requestPlanApproval to explore the codebase and request execution approval.',
    'Your goal is to produce a PRD document and (optionally) a structured execution plan.',
    '',
    '## Workflow (5 phases)',
    '',
    '1. **Initial Understanding** — Read code and gather context. To parallelise exploration, use the `agent` tool to spawn bounded read-only sub-agents; up to 3 in parallel. Each sub-agent returns a focused report.',
    '2. **Design** — Synthesise findings. Optionally spawn planning sub-agents (1–3 in parallel) to draft alternative implementation approaches and surface trade-offs.',
    '3. **Review** — Read the critical files identified by your subagents directly so you understand them first-hand. If anything is ambiguous, ask the user a focused question.',
    '4. **Final Plan** — Write the PRD via `plan/updatePrd`. Lead with a **Context** section (why this change), then your single recommended approach, the paths of files to modify, existing functions/utilities to reuse, and a **Verification** section. Then call `plan/setPlanTree` with `{ "tree": <FlowNode> }` — a JSON noetic flow built from the step primitives (`step.llm`, `step.branch`, `step.fork`, `step.spawn`, `step.loop`); every node needs a unique `id`.',
    '5. **Exit** — Call `plan/exitPlanMode` with `{ action: "execute" }` to request approval. The user must accept before execution begins; if they reject, you stay in Plan Mode and may revise.',
    '',
    '## Available actions',
    '- `plan/updatePrd` — set markdown PRD content',
    '- `plan/setPlanTree` — set the optional JSON execution plan',
    '- `plan/exitPlanMode` `{ action: "execute" }` — request approval and exit to executing',
    '- `plan/exitPlanMode` `{ action: "cancel" }` — discard plan and return to idle',
    '',
    '## Constraints',
    '- DO NOT create, modify, or delete files (other than via `plan/updatePrd` and `plan/setPlanTree`).',
    '- DO NOT run mutating shell commands. Read-only exploration only.',
    '- End each turn either by asking the user a focused clarifying question or by calling `plan/exitPlanMode`.',
  ];

  if (additionalInstructions) {
    sections.push('', '## Additional Instructions', '', additionalInstructions);
  }

  if (state.prd) {
    sections.push('', '## Current PRD Draft', '', state.prd);
  }

  if (state.planTree) {
    sections.push('', '## Current Plan Tree', '', JSON.stringify(state.planTree, null, 2));
  }

  sections.push('</plan_mode>');
  return sections.join('\n');
}

function recallExecuting(state: PlanState): string {
  const sections: string[] = [
    '<active_plan>',
    '## PRD',
    '',
    state.prd ?? '',
  ];
  if (state.planTree) {
    sections.push('', '## Execution Plan', '', JSON.stringify(state.planTree, null, 2));
  }
  sections.push('</active_plan>');
  return sections.join('\n');
}

function recallTerminal(state: PlanState): string {
  const lastEntry = state.executionLog[state.executionLog.length - 1];
  const outcome = lastEntry?.outcome ?? 'unknown';
  return `<plan_outcome>Plan v${state.version} ${outcome}.</plan_outcome>`;
}

type RecallRenderer = (state: PlanState, additionalInstructions?: string) => string;

const RECALL_RENDERERS: Partial<Record<PlanPhase, RecallRenderer>> = {
  [PlanPhase.Planning]: recallPlanning,
  [PlanPhase.Executing]: recallExecuting,
  [PlanPhase.Completed]: recallTerminal,
  [PlanPhase.Failed]: recallTerminal,
};

//#endregion

//#region Public API

/**
 * Creates a plan memory layer that manages the PRD authoring and plan execution lifecycle.
 *
 * @public
 * @param config - Optional configuration for scope, allowed tools, and limits.
 * @returns A `MemoryLayer` providing plan mode, PRD storage, and execution tracking.
 */
export function planMemory(config?: PlanMemoryConfig): MemoryLayer<PlanState> {
  const scope: MemoryScope = config?.scope ?? 'thread';
  const maxPrdLength = config?.maxPrdLength ?? MAX_PRD_LENGTH;
  const maxTreeDepth = config?.maxTreeDepth ?? MAX_TREE_DEPTH;
  const allowedTools = buildAllowedTools(config);
  const additionalPlanInstructions = config?.additionalPlanInstructions;
  const onEnterSession = config?.onEnterSession;
  const onExit = config?.onExit;

  return {
    id: 'plan',
    name: 'Plan Memory',
    slot: PLAN_SLOT,
    scope,
    budget: {
      min: 100,
      max: 3e3,
    },
    provides: {
      status: layerData<
        {
          phase: PlanPhase;
          hasPrd: boolean;
          hasPlanTree: boolean;
          version: number;
        },
        PlanState
      >({
        read: (state) => ({
          phase: state.phase,
          hasPrd: Boolean(state.prd),
          hasPlanTree: state.planTree !== null,
          version: state.version,
        }),
      }),

      enterPlanMode: layerFn<
        {
          goal?: string;
        },
        string,
        PlanState
      >({
        description:
          'Enter plan mode. The agent switches to read-only exploration and PRD authoring.',
        input: z.object({
          goal: z.string().optional(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase === PlanPhase.Planning || state.phase === PlanPhase.Executing) {
            return {
              result: `Cannot enter plan mode: a plan is already active (phase "${state.phase}").`,
              state,
            };
          }
          const session = onEnterSession ? await onEnterSession() : null;
          return {
            result: 'Plan mode activated. Explore the codebase, then call plan/updatePrd.',
            state: {
              ...state,
              phase: PlanPhase.Planning,
              prd: args.goal ? `# Goal\n\n${args.goal}\n` : null,
              planTree: null,
              executionLog: [],
              version: state.version + 1,
              planSlug: session?.slug ?? null,
            },
          };
        },
      }),

      updatePrd: layerFn<
        {
          content: string;
        },
        string,
        PlanState
      >({
        description: 'Update the PRD document with new markdown content.',
        input: z.object({
          content: z.string(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot update PRD: current phase is "${state.phase}". Enter plan mode first.`,
              state,
            };
          }
          if (args.content.length > maxPrdLength) {
            return {
              result: `PRD content exceeds maximum length of ${maxPrdLength} characters.`,
              state,
            };
          }
          return {
            result: 'PRD updated successfully.',
            state: {
              ...state,
              prd: args.content,
            },
          };
        },
      }),

      setPlanTree: layerFn<
        {
          tree: FlowNode;
        },
        string,
        PlanState
      >({
        description:
          'Set the execution plan tree. Pass { "tree": <FlowNode> }, where FlowNode is a discriminated union with kind: "llm" | "subagent" | "fork" | "spawn" | "sequence" and every node has a unique "id". Structural nodes (sequence, fork, spawn) nest child FlowNodes; leaf nodes (llm, subagent) carry execution instructions.',
        // Wrapped in an object so the tool exposes a top-level object schema — a
        // bare discriminated union is not a valid tool-parameter shape for the
        // OpenAI/Anthropic tool APIs and is rejected over the wire.
        input: z.object({
          tree: FlowSchema,
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot set plan tree: current phase is "${state.phase}". Enter plan mode first.`,
              state,
            };
          }
          if (!validateTreeDepth(args.tree, maxTreeDepth)) {
            return {
              result: `Plan tree exceeds maximum depth of ${maxTreeDepth}.`,
              state,
            };
          }
          return {
            result: 'Plan tree set successfully. Call plan/exitPlanMode to begin execution.',
            state: {
              ...state,
              planTree: args.tree,
            },
          };
        },
      }),

      exitPlanMode: layerFn<
        {
          action: 'execute' | 'cancel';
        },
        string,
        PlanState
      >({
        description:
          'Exit plan mode. Use action "execute" to begin executing the plan, or "cancel" to discard it.',
        input: z.object({
          action: z.enum([
            'execute',
            'cancel',
          ]),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.phase !== PlanPhase.Planning) {
            return {
              result: `Cannot exit plan mode: current phase is "${state.phase}".`,
              state,
            };
          }

          if (args.action === 'cancel') {
            return {
              result: 'Plan cancelled. Returned to idle.',
              state: createDefaultState(),
            };
          }

          if (!state.prd) {
            return {
              result: 'Cannot execute: no PRD has been written. Call plan/updatePrd first.',
              state,
            };
          }
          if (!state.planTree) {
            return {
              result: 'Cannot execute: no plan tree has been set. Call plan/setPlanTree first.',
              state,
            };
          }

          if (onExit) {
            const { approved } = await onExit(state);
            if (!approved) {
              return {
                result:
                  'User did not approve the plan. Stay in plan mode, address their feedback, and call plan/exitPlanMode again when ready.',
                state,
              };
            }
          }

          return {
            result: 'Plan mode exited. Execution phase begun.',
            state: {
              ...state,
              phase: PlanPhase.Executing,
            },
          };
        },
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<PlanState>('state');
        return {
          state: saved ?? createDefaultState(),
        };
      },

      async recall({ state, budget }) {
        if (state.phase === PlanPhase.Idle) {
          return null;
        }

        const renderer = RECALL_RENDERERS[state.phase];
        if (!renderer) {
          return null;
        }

        const content = renderer(state, additionalPlanInstructions);
        // Respect the budget: estimateTokens uses ~4 chars/token, so cap the
        // rendered text at budget*4 chars to keep tokenCount <= budget.
        const maxChars = budget * 4;
        const trimmed = content.length > maxChars ? content.slice(0, maxChars) : content;
        return {
          items: [
            createMessage(trimmed, 'developer'),
          ],
          tokenCount: estimateTokens(trimmed),
        };
      },

      async beforeToolCall({ toolName, state }) {
        if (state.phase !== PlanPhase.Planning) {
          return {
            decision: {
              action: SteeringAction.Allow,
            },
            state,
          };
        }

        if (allowedTools.has(toolName)) {
          return {
            decision: {
              action: SteeringAction.Allow,
            },
            state,
          };
        }

        return {
          decision: {
            action: SteeringAction.Deny,
            guidance: `Plan mode is active. "${toolName}" is not allowed during planning. Use read-only tools (Read, Grep, Find, Ls) to explore the codebase, then call plan/updatePrd to write your PRD.`,
          },
          state,
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },

      async onComplete({ state, outcome }) {
        if (state.phase !== PlanPhase.Executing) {
          return;
        }

        return {
          state: {
            ...state,
            phase: outcome === 'success' ? PlanPhase.Completed : PlanPhase.Failed,
            executionLog: trimExecutionLog([
              ...state.executionLog,
              {
                timestamp: Date.now(),
                version: state.version,
                outcome,
              },
            ]),
          },
        };
      },
    },
  } satisfies MemoryLayer<PlanState>;
}

//#endregion
