/**
 * Task-specific runner-harness factory + a thin task-aware wrapper around
 * the core `runnableLoop` primitive.
 *
 * Since Phase B, the generic "single-shot deferred" and "seed + drive one
 * turn" primitives live in `@noetic/core` as `createDetachedSignal` and
 * `runnableLoop`. What remains here is task-domain:
 *
 *   - `createRunnerHarness(opts)` builds a chat-shaped `AgentHarness` via
 *     `createCodeAgent`, which bakes in the standard coding tools and
 *     role-specific memory layers the task runners need.
 *   - `runRunnerLoop(opts)` reads prior chat history from `<taskDir>/chat.jsonl`
 *     via `readChatHistory`, then delegates to `runnableLoop` in core,
 *     wiring the optional stall-nudge hook with task-specific detection
 *     (`askUserService.peek()`) and escalation (`escalateStalledRunner`).
 *   - `escalateStalledRunner(args)` persists an `agent_stalled` pause to
 *     the task record and appends the matching event.
 *
 * Stall recovery: when the runner is configured with `nudge`, the loop
 * detects an agent that finished its first turn without calling either
 * a terminal tool or `AskUserQuestion`. The runner sends one developer-
 * role nudge message. If the agent stalls a second time, the runner
 * pauses the task with `pauseReason=agent_stalled` and resolves the
 * signal with `buildStalledOutcome()` so the parent unwinds cleanly.
 *
 * Compat aliases (`RunnerSignal`, `createRunnerSignal`) re-export the
 * core names under the pre-Phase-B spelling so existing CLI / test
 * callers keep compiling until Phase D renames them at the call sites.
 */

import type {
  AgentHarness,
  DetachedSignal,
  FsAdapter,
  InputMessageItem,
  MemoryLayer,
  RunnableLoopHarness,
  ShellAdapter,
  Tool,
} from '@noetic/core';
import {
  createDetachedSignal,
  createNudgeMessage,
  createStallNudgeHook,
  runnableLoop,
} from '@noetic/core';

import type { AskUserService } from '../ask-user-service.js';
import { createCodeAgent } from '../index.js';
import { readChatHistory } from './chat-history-store.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, loadTask, saveTask } from './fs-store.js';
import { EventKind, TaskPauseReason } from './schemas.js';

//#region Types

export type RunnerRole = 'planner' | 'implementer' | 'validator';

/**
 * Deferred signal a role's terminal tool resolves to end the runner loop.
 * Kept as a name alias over the canonical `DetachedSignal` so existing
 * callers keep compiling; new code should prefer `DetachedSignal` from
 * `@noetic/core`.
 */
export type RunnerSignal<TOutcome> = DetachedSignal<TOutcome>;

/**
 * Minimum harness subset the runner loop calls into. Kept as an alias
 * over the canonical `RunnableLoopHarness` for the same reason.
 */
export type RunnerLoopHarness = RunnableLoopHarness;

export interface RunnerHarnessOpts {
  readonly role: RunnerRole;
  readonly taskId: string;
  /** cwd the agent operates in (worktree for implementer, project root for others). */
  readonly cwd: string;
  readonly apiKey: string;
  readonly model: string;
  /** Role-specific system instructions baked into `initialStep`. */
  readonly instructions: string;
  /**
   * Tools exposed to the LLM. Callers compose this from `createCodingTools`
   * + role-specific terminal tools.
   */
  readonly tools: ReadonlyArray<Tool>;
  /** Memory layers mounted on the harness (steering, fix-feedback, etc.). */
  readonly memory: ReadonlyArray<MemoryLayer>;
  readonly fs: FsAdapter;
  /**
   * Shell used by the underlying code-agent (e.g. for the bash tool).
   * Required — the SDK stays portable by never reaching for a local
   * adapter implicitly.
   */
  readonly shell: ShellAdapter;
}

export interface RunnerHarnessResult {
  readonly harness: AgentHarness<{
    model: string;
  }>;
  readonly threadId: string;
}

/**
 * Optional stall-recovery configuration for {@link runRunnerLoop}. When
 * provided, the loop sends one nudge message after the first turn ends
 * without progress, then escalates by pausing the task and resolving
 * the signal with `buildStalledOutcome()`.
 */
export interface RunRunnerNudgeOpts<TOutcome> {
  readonly role: RunnerRole;
  readonly askUserService: AskUserService;
  readonly buildStalledOutcome: () => TOutcome;
}

export interface RunRunnerLoopOpts<TOutcome> {
  readonly harness: RunnerLoopHarness;
  readonly threadId: string;
  /**
   * Developer-role framing message that kicks off a fresh runner spawn.
   * Passed as a single `Item` to `harness.execute()` so the harness emits
   * it through `getItemStream()` and the IPC server persists it to
   * `chat.jsonl` via the normal stream path — no separate write needed.
   */
  readonly initialMessage: InputMessageItem;
  readonly signal: RunnerSignal<TOutcome>;
  /** Backing context for chat history seeding (project-rooted, not task-rooted). */
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly nudge?: RunRunnerNudgeOpts<TOutcome>;
}

//#endregion

//#region Public API

/**
 * Single-shot deferred signal a role's terminal tool resolves on
 * completion. Kept as a re-export of the canonical core primitive under
 * the pre-Phase-B name; existing callers keep compiling.
 */
export const createRunnerSignal = createDetachedSignal;

/**
 * Construct an `AgentHarness` configured for a runner role. The returned
 * harness has `initialStep` populated so callers drive it via `execute()`
 * rather than `run()`.
 */
export async function createRunnerHarness(opts: RunnerHarnessOpts): Promise<RunnerHarnessResult> {
  const codeAgent = await createCodeAgent({
    name: `noetic-${opts.role}`,
    model: opts.model,
    cwd: opts.cwd,
    adapters: {
      fs: opts.fs,
      shell: opts.shell,
    },
    tools: opts.tools,
    memory: [
      ...opts.memory,
    ],
    instructions: opts.instructions,
    defaultMemory: false,
    llm: {
      provider: 'openrouter',
      apiKey: opts.apiKey,
    },
  });
  const harness = codeAgent.harness;

  const threadId = `noetic-${opts.role}-${opts.taskId}-${Date.now()}`;

  return {
    harness,
    threadId,
  };
}

/**
 * Persist an `agent_stalled` pause to the task and append an event so
 * the kanban surfaces it. Pure I/O — extracted for direct unit testing
 * and reused by the nudge hook below.
 */
export async function escalateStalledRunner(args: {
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly role: RunnerRole;
}): Promise<void> {
  const ts = new Date().toISOString();
  const task = await loadTask(args.storeCtx, args.taskId);
  await saveTask(args.storeCtx, {
    ...task,
    paused: true,
    pauseReason: TaskPauseReason.AgentStalled,
    updatedAt: ts,
  });
  await appendEvent(args.storeCtx, {
    kind: EventKind.TaskUpdated,
    taskId: args.taskId,
    payload: {
      phase: 'agent_stalled',
      role: args.role,
    },
    ts,
  });
}

/**
 * Drive a runner harness through its lifecycle:
 *
 *   1. Read prior chat history from `<taskDir>/chat.jsonl` and seed the
 *      harness session via `runnableLoop` (resume path — no kick-off).
 *   2. If no prior history, execute the role's developer-framing message
 *      as the first turn. The IPC server's stream pump persists the
 *      emitted items to chat.jsonl naturally.
 *   3. Stall recovery (fresh spawn only, when `nudge` is configured):
 *      detect first-turn stalls via `askUserService.peek()`, send one
 *      nudge, re-check after the second turn, escalate with
 *      `escalateStalledRunner` + resolve the signal with
 *      `buildStalledOutcome()` on a second stall.
 *   4. Await the role's terminal signal.
 *
 * Returns the resolved outcome. If the signal rejects, this rejects with
 * the same reason.
 */
export async function runRunnerLoop<TOutcome>(
  opts: RunRunnerLoopOpts<TOutcome>,
): Promise<TOutcome> {
  const priorItems = await readChatHistory(opts.storeCtx, opts.taskId);
  const nudge = opts.nudge;
  const afterFirstTurn =
    nudge === undefined
      ? undefined
      : createStallNudgeHook({
          harness: opts.harness,
          threadId: opts.threadId,
          signal: opts.signal,
          nudgeMessage: createNudgeMessage({
            id: `runner-nudge-${opts.taskId}-${Date.now()}`,
          }),
          hasPendingExternal: () => nudge.askUserService.peek() !== null,
          onStall: () =>
            escalateStalledRunner({
              storeCtx: opts.storeCtx,
              taskId: opts.taskId,
              role: nudge.role,
            }),
          buildStalledOutcome: nudge.buildStalledOutcome,
        });

  return runnableLoop<TOutcome>({
    harness: opts.harness,
    threadId: opts.threadId,
    priorItems,
    initialMessage: opts.initialMessage,
    signal: opts.signal,
    afterFirstTurn,
  });
}

//#endregion
