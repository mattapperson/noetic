/**
 * `agent` tool — spawn a sub-agent (teammate) with a per-type system prompt
 * and tool allowlist drawn from the skills catalog. Composes `@noetic-tools/core`
 * primitives (`spawn`, `react`, `harness.run`, `harness.detachedSpawn`,
 * memory layers).
 *
 * Modes:
 *   - sync (default): block until child finishes, return its output. Worktree
 *     cleanup defaults to `'never'` so the user can inspect what ran.
 *   - background (`run_in_background: true` or skill `agent-background: true`):
 *     launch detached on a fresh threadId so the child does NOT pollute the
 *     parent's accumulated session items. The inbox-drain memory layer
 *     surfaces completion to the parent's next turn.
 *   - named (`name: ...`, implies background): as above plus a per-name
 *     inbound queue addressable via the `sendMessage` tool. The teammate
 *     consumes its inbound queue via `teammateInboundLayer`.
 *   - nested spawning: disabled by default for child agents; skills opt in
 *     with `agent-can-spawn: true` so top-level plan/act agents can delegate
 *     without making every teammate recursively agentic.
 *   - worktree isolation (`isolation: 'worktree'`): allocate a git worktree.
 *     The child's tools are the same instances as the parent's — they resolve
 *     paths from the live `ctx.cwdState.cwd`, which is initialized to the
 *     worktree path on the child context. No per-cwd tool rebuilding.
 */

import { randomUUID } from 'node:crypto';
import { createLocalFsAdapter } from '@noetic/platform-node';
import type { ContextMemory, DetachedHandle, MemoryLayer, Tool } from '@noetic-tools/core';
import { historyWindow, NoeticConfigError, react, spawn, step, tool } from '@noetic-tools/core';
import { retargetCwdForSpawn } from '@noetic-tools/core/unstable';
import { z } from 'zod';

import { createAgentWorktree } from '../adapters/worktree.js';
import type { TeammateRegistry } from '../agents/registry-runtime.js';
import { unknownAgentType } from '../errors/worktree-errors.js';
import { teammateInboundLayer } from '../memory/teammate-inbound-layer.js';
import { getAgent, listAgents } from '../skills/catalog.js';
import type { SkillDefinition } from '../skills/types.js';
import { ensureWorktreeTask } from '../tasks/worktree-tasks.js';
import type { AgentOverride, WorktreeConfig } from '../types/config.js';
import * as log from '../util/log.js';

//#region Constants

/** Max teammate name length, including the leading letter. */
export const TEAMMATE_NAME_MAX_LENGTH = 63;

/**
 * Validation pattern for the teammate `name` input. Restricted to a safe
 * character set so user-supplied values can be interpolated into shell
 * commands (worktree branch / path templates) without escape concerns.
 * Exported so tests can validate the same regex used at runtime.
 */
export const TEAMMATE_NAME_PATTERN = new RegExp(
  `^[a-zA-Z][a-zA-Z0-9_-]{0,${TEAMMATE_NAME_MAX_LENGTH - 1}}$`,
);

//#endregion

//#region Types

export interface CreateAgentToolArgs {
  catalog: ReadonlyArray<SkillDefinition>;
  teammates: TeammateRegistry;
  /**
   * Parent tool pool. Same instances are reused for every child invocation —
   * tools read live cwd from the executing context's `cwdState`, so
   * worktree isolation initializes the child's cwdState instead of rebuilding
   * tools per worktree path.
   */
  parentTools: ReadonlyArray<Tool>;
  parentModel: string;
  worktreeConfig: WorktreeConfig | undefined;
  cwd: string;
  /**
   * Cap on items projected to the LLM, inherited from the parent's `history.maxItems`.
   * When set, every spawned teammate also gets a `historyWindow` layer; when
   * unset, teammates are uncapped. Inheriting teammates pick this up via the
   * parent's memory stack; non-inheriting ones receive an explicit instance.
   */
  historyMaxItems: number | undefined;
  /**
   * Per-sub-agent overrides keyed by `agent-type`. Beats the matching
   * SKILL.md frontmatter for `model`, `instructions`, and `allowed-tools`.
   * Sourced from `noetic.config.ts`'s `agents` field.
   */
  agentOverrides?: Record<string, AgentOverride>;
  /** Tool names that provide teammate orchestration and enable nested spawning. */
  teammateToolNames?: ReadonlyArray<string>;
}

interface ResolvedAgent {
  skill: SkillDefinition;
  model: string;
  tools: Tool[];
  background: boolean;
  /** Final instructions after applying any `instructions` / `instructionsMode` override. */
  instructions: string;
}

export const AgentInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('Short (3-5 word) description of the task. Used in UI and traces.'),
  prompt: z.string().min(1).describe('The task for the sub-agent to perform.'),
  subagent_type: z
    .string()
    .optional()
    .describe('Agent type id (from a skill with `agent-type` set). Defaults to "general-purpose".'),
  model: z
    .string()
    .optional()
    .describe('Model id override. Skill `agent-model` wins, then this, then parent model.'),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Launch detached on a fresh threadId; return immediately. Completion notice arrives on next parent turn.',
    ),
  name: z
    .string()
    .regex(
      TEAMMATE_NAME_PATTERN,
      `name must be 1-${TEAMMATE_NAME_MAX_LENGTH} chars, alphanumeric/underscore/dash, starting with a letter`,
    )
    .optional()
    .describe(
      'Make this teammate addressable via `sendMessage({ to: name, ... })`. Implies background.',
    ),
  isolation: z
    .literal('worktree')
    .optional()
    .describe(
      'Run the child in an isolated git worktree (per `worktree` config in noetic.config.ts).',
    ),
  inherit_context: z
    .boolean()
    .optional()
    .describe(
      "Inherit the parent agent's memory layers (CLAUDE.md, working memory, etc). Default false (fresh).",
    ),
});

export const AgentOutputSchema = z.union([
  z.object({
    status: z.literal('completed'),
    agentId: z.string(),
    result: z.string(),
    worktreePath: z.string().optional(),
  }),
  z.object({
    status: z.literal('async_launched'),
    agentId: z.string(),
    name: z.string().optional(),
    worktreePath: z.string().optional(),
  }),
]);

export type AgentInput = z.infer<typeof AgentInputSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

//#endregion

//#region Resolver helpers

interface ResolveAgentArgs {
  input: AgentInput;
  catalog: ReadonlyArray<SkillDefinition>;
  parentTools: ReadonlyArray<Tool>;
  parentModel: string;
  agentOverrides?: Record<string, AgentOverride>;
  teammateToolNames?: ReadonlyArray<string>;
}

export function resolveAgent(args: ResolveAgentArgs): ResolvedAgent {
  const requestedType = args.input.subagent_type ?? 'general-purpose';
  const skill = getAgent(args.catalog, requestedType);
  if (!skill) {
    throw unknownAgentType({
      requested: requestedType,
      available: listAgents(args.catalog).map((s) => s.agentType ?? ''),
    });
  }

  const override = args.agentOverrides?.[requestedType];

  const skillModel = skill.agentModel;
  const fallbackModel =
    skillModel && skillModel !== 'inherit' ? skillModel : (args.input.model ?? args.parentModel);
  const model = override?.model ?? fallbackModel;

  const instructions = applyInstructionsOverride(skill.instructions, override);

  const allowList = override?.tools ?? skill.allowedTools;
  const tools = resolveChildTools({
    parentTools: args.parentTools,
    allowList,
    teammateToolNames: new Set(args.teammateToolNames ?? []),
    canSpawn: skill.agentCanSpawn === true,
  });

  const background = args.input.run_in_background === true || skill.agentBackground === true;

  return {
    skill,
    model,
    tools,
    background,
    instructions,
  };
}

/**
 * Apply the `instructions` / `instructionsMode` override on top of the
 * SKILL.md body. Default is `'append'` — concat after the body separated by
 * a blank line. `'replace'` swaps the body out entirely.
 */
function applyInstructionsOverride(base: string, override: AgentOverride | undefined): string {
  if (override?.instructions === undefined) {
    return base;
  }
  if (override.instructionsMode === 'replace') {
    return override.instructions;
  }
  return `${base}\n\n${override.instructions}`;
}

function withoutTeammateTools(
  tools: ReadonlyArray<Tool>,
  teammateToolNames: ReadonlySet<string>,
): Tool[] {
  return tools.filter((agentTool) => !teammateToolNames.has(agentTool.name));
}

/**
 * If the skill declares an `allowed-tools` list, filter the parent's tool pool
 * down to those names. Empty array means "no tools" (LLM-only). When the field
 * is omitted, the child inherits the full parent tool pool.
 */
export function filterTools(
  parentTools: ReadonlyArray<Tool>,
  allowed: ReadonlyArray<string> | undefined,
): Tool[] {
  if (allowed === undefined) {
    return [
      ...parentTools,
    ];
  }
  if (allowed.length === 0) {
    return [];
  }
  const allowSet = new Set(allowed);
  return parentTools.filter((t) => allowSet.has(t.name));
}

function resolveChildTools(args: {
  parentTools: ReadonlyArray<Tool>;
  allowList: ReadonlyArray<string> | undefined;
  teammateToolNames: ReadonlySet<string>;
  canSpawn: boolean;
}): Tool[] {
  const availableTools = args.canSpawn
    ? args.parentTools
    : withoutTeammateTools(args.parentTools, args.teammateToolNames);
  return filterTools(availableTools, args.allowList);
}

//#endregion

//#region Child step builder

interface BuildChildStepArgs {
  agentId: string;
  resolved: ResolvedAgent;
  inheritContext: boolean;
  /** Extra memory layers to attach (e.g. teammateInboundLayer for named teammates). */
  extraMemory: MemoryLayer[];
}

function buildChildStep(args: BuildChildStepArgs) {
  const { agentId, resolved, inheritContext, extraMemory } = args;
  const child =
    resolved.tools.length > 0
      ? react({
          model: resolved.model,
          instructions: resolved.instructions,
          tools: resolved.tools,
          maxSteps: resolved.skill.agentMaxSteps,
        })
      : step.llm<ContextMemory, string, string>({
          id: `agent-${agentId}-llm`,
          model: resolved.model,
          instructions: resolved.instructions,
        });

  // Memory semantics:
  //   inherit_context=true + extras → undefined (inherit) merged with extras
  //     is not supported by spawn directly; pick inheritance OR extras.
  //   inherit_context=true (no extras) → undefined (inherit parent layers)
  //   inherit_context=false (no extras) → [] (replace parent layers, fresh)
  //   no inherit + extras → just the extras (e.g. teammateInboundLayer alone)
  // When both are requested we honor `inherit_context` and skip the extra
  // layer with a warning — see comment in agent.ts caller for the reasoning.
  const memory = inheritContext ? INHERIT_PARENT_MEMORY : extraMemory;

  return spawn<ContextMemory, string, string>({
    id: `agent-${agentId}`,
    child,
    memory,
  });
}

/** `spawn({ memory: undefined })` semantics: inherit parent layers via executeSpawn. */
const INHERIT_PARENT_MEMORY = undefined;

//#endregion

//#region Settlement notification

interface NotifyOnSettleArgs {
  handle: DetachedHandle<string>;
  agentLabel: string;
  worktreeCleanup?: () => Promise<unknown>;
  /** Held weakly so a TUI-driven `dropAll()` lets the registry get GC'd. */
  registryRef: WeakRef<TeammateRegistry>;
}

function notifyOnSettle(args: NotifyOnSettleArgs): void {
  const warnCleanup = (cleanupErr: unknown): undefined => {
    const msg = cleanupErr instanceof Error ? cleanupErr.message : 'unknown error';
    log.warn(`[agent ${args.handle.id}] worktree cleanup failed: ${msg}`);
    return undefined;
  };
  void args.handle
    .await()
    .then(
      async (result) => {
        if (args.worktreeCleanup) {
          await args.worktreeCleanup().catch(warnCleanup);
        }
        args.registryRef.deref()?.postNotice(formatComplete(args.agentLabel, result));
      },
      async (err: unknown) => {
        if (args.worktreeCleanup) {
          await args.worktreeCleanup().catch(warnCleanup);
        }
        const message = err instanceof Error ? err.message : 'unknown error';
        args.registryRef.deref()?.postNotice(formatFailure(args.agentLabel, message));
      },
    )
    .catch((innerErr: unknown) => {
      // Last-resort guard against synchronous throws inside the then callbacks
      // (e.g. tokenize failures inside formatComplete). These would otherwise
      // surface as unhandled rejections and crash the process.
      const msg = innerErr instanceof Error ? innerErr.message : 'unknown error';
      log.warn(`[agent ${args.handle.id}] notifyOnSettle inner error: ${msg}`);
    });
}

function formatComplete(label: string, result: string): string {
  return `[teammate ${label} completed]\n${result}`;
}

function formatFailure(label: string, message: string): string {
  return `[teammate ${label} failed] ${message}`;
}

//#endregion

//#region Tool factory

export function createAgentTool(args: CreateAgentToolArgs): Tool {
  const registryRef = new WeakRef(args.teammates);
  // Build the teammate's history-window layer once per harness; the layer's
  // state is keyed per-execution so a single instance is safe across spawns.
  const teammateHistoryLayer =
    args.historyMaxItems !== undefined
      ? historyWindow({
          maxItems: args.historyMaxItems,
        })
      : undefined;
  return tool({
    name: 'agent',
    description:
      'Spawn a sub-agent (teammate) with a per-type system prompt and tool allowlist. Sync by default; pass `run_in_background` for detached, or `name` for an addressable teammate. Use `subagent_type` to pick from registered agent skills.',
    input: AgentInputSchema,
    output: AgentOutputSchema,
    execute: async (input, toolCtx): Promise<AgentOutput> => {
      const { name: teammateName } = input;
      const agentId = makeAgentId(teammateName);

      // Worktree allocation up front. The child's tools (built below) are
      // rooted at `worktreePath` so file operations stay inside the worktree.
      // For sync mode, default cleanup is `'never'` so the user can inspect.
      let worktreeCleanup: (() => Promise<unknown>) | undefined;
      let worktreePath: string | undefined;
      if (input.isolation === 'worktree') {
        const isAsync = teammateName !== undefined || input.run_in_background === true;
        const wt = await createAgentWorktree({
          agentId,
          cwd: args.cwd,
          shell: toolCtx.shell,
          config: args.worktreeConfig,
          // Async / named teammates default to 'if-clean'; sync to 'never' so
          // the user can inspect what the agent did. Explicit config still wins.
          defaultCleanup: isAsync ? 'if-clean' : 'never',
        });
        worktreePath = wt.worktreePath;
        worktreeCleanup = wt.cleanup;
        await ensureWorktreeTask({
          ctx: {
            fs: createLocalFsAdapter(),
            projectRoot: wt.projectRoot,
          },
          projectRoot: wt.projectRoot,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
        });
      }

      const resolved = resolveAgent({
        input,
        catalog: args.catalog,
        parentTools: args.parentTools,
        parentModel: args.parentModel,
        agentOverrides: args.agentOverrides,
        teammateToolNames: args.teammateToolNames,
      });

      const inheritContext = input.inherit_context === true;

      // Extra memory layers attached to the child. For named teammates, the
      // inbound-drain layer lets the child consume `sendMessage` payloads on
      // each turn without an explicit recv.
      const extraMemory: MemoryLayer[] = [];
      if (teammateName !== undefined) {
        extraMemory.push(
          teammateInboundLayer({
            teammates: args.teammates,
            name: teammateName,
          }),
        );
        if (inheritContext) {
          // spawn() takes EITHER undefined (inherit) OR an explicit array
          // (replace). We can't have both; document the trade-off and prefer
          // the explicit inbound layer since otherwise sendMessage is dead.
          log.warn(
            `[agent ${agentId}] inherit_context=true with name=${teammateName}: inbound layer requires fresh memory; ignoring inherit_context.`,
          );
        }
      }
      // Apply the same history cap to teammates as the parent. Inheriting
      // teammates already see the parent's `historyWindow` layer; non-
      // inheriting teammates need an explicit instance here.
      const willInheritParent = inheritContext && extraMemory.length === 0;
      if (teammateHistoryLayer && !willInheritParent) {
        extraMemory.push(teammateHistoryLayer);
      }

      const childStep = buildChildStep({
        agentId,
        resolved,
        inheritContext: willInheritParent,
        extraMemory,
      });

      const isAsync = resolved.background || teammateName !== undefined;

      if (!isAsync) {
        // Worktree isolation: the spawned child snapshots `parent.cwdState.cwd`
        // at spawn-construction time. Briefly retarget the parent's cwd to the
        // worktree path so the snapshot lands on the worktree, then restore.
        // Sync spawn awaits, so this short-lived mutation is invisible to
        // anything else (no concurrent tool calls on this parent context).
        const restoreCwd = worktreePath
          ? retargetCwdForSpawn(toolCtx.ctx, worktreePath)
          : undefined;
        try {
          const result = await toolCtx.harness.run(childStep, input.prompt, toolCtx.ctx);
          return {
            status: 'completed',
            agentId,
            result,
            worktreePath,
          };
        } finally {
          restoreCwd?.();
          if (worktreeCleanup) {
            await worktreeCleanup().catch((cleanupErr: unknown) => {
              const msg = cleanupErr instanceof Error ? cleanupErr.message : 'unknown error';
              log.warn(`[agent ${agentId}] worktree cleanup failed: ${msg}`);
            });
          }
        }
      }

      // Async path: detachedSpawn with overrides.threadId so the child gets
      // its own per-teammate session-scoped item log and does not pollute
      // the parent's `session.accumulatedItems`. `cwdInit` initializes the
      // detached child's cwdState to the worktree path when isolated.
      const handle = toolCtx.harness.detachedSpawn(childStep, input.prompt, toolCtx.ctx, {
        threadId: `teammate-${agentId}`,
        cwdInit: worktreePath,
      });
      try {
        if (teammateName !== undefined) {
          args.teammates.registerByName(teammateName, {
            handle,
            inbox: [],
          });
        } else {
          args.teammates.registerById(handle);
        }

        notifyOnSettle({
          handle,
          agentLabel: teammateName ?? agentId,
          worktreeCleanup,
          registryRef,
        });

        return {
          status: 'async_launched',
          agentId: handle.id,
          name: teammateName,
          worktreePath,
        };
      } catch (e) {
        // Observe the orphan handle so its eventual rejection doesn't surface
        // as an unhandledRejection.
        void handle.await().catch(() => undefined);
        if (worktreeCleanup) {
          await worktreeCleanup().catch(() => undefined);
        }
        if (e instanceof Error) {
          throw e;
        }
        throw new NoeticConfigError({
          code: 'AGENT_REGISTRATION_FAILED',
          message: 'Failed to register spawned teammate.',
          hint: 'Check the harness logs for the underlying error.',
        });
      }
    },
  });
}

//#endregion

//#region Helpers

function makeAgentId(name: string | undefined): string {
  const short = randomUUID().slice(0, 12);
  return name !== undefined ? `${name}-${short}` : `agent-${short}`;
}

//#endregion
