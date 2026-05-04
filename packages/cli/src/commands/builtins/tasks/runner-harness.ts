/**
 * Build a chat-shaped `AgentHarness` for a task runner subprocess.
 *
 * Each runner role (planner, implementer, validator) re-uses the same
 * turn-based chat shape as the main TUI: an LLM step with the standard
 * coding tools wired through `harness.execute()` and `getAgentResponse()`.
 * The differences are:
 *
 *   - role-specific system instructions
 *   - role-specific terminal tools that signal "I'm done" by resolving a
 *     `RunnerSignal<TOutcome>` deferred the runner awaits
 *   - role-specific extra memory layers (steering, fix-feedback, etc.)
 *   - a fresh `threadId` per runner invocation so the chat history is
 *     scoped to this run and resumable from `<taskDir>/chat.jsonl`
 *
 * The runner loop is intentionally minimal: seed prior chat history,
 * kick off the first turn, then await the role's terminal signal. The
 * IPC server (mounted by the runner) lets external clients (the TUI)
 * keep injecting `execute()` calls between agent turns. The session
 * stays alive until the agent calls a terminal tool, the signal is
 * rejected, or the process is signalled to exit.
 *
 * Stall recovery: when the runner is configured with `nudge`, the loop
 * detects an agent that finished its first turn without calling either
 * a terminal tool or `AskUserQuestion`. The runner sends one developer-
 * role nudge message reminding the agent to either call its terminal
 * tool or ask the user. If the agent stalls a second time, the runner
 * pauses the task with `pauseReason=agent_stalled` and resolves the
 * signal with `buildStalledOutcome()` so the parent unwinds cleanly.
 */

import { createCodeAgent } from '@noetic/code-agent';
import type {
  AgentHarness,
  ExecuteInput,
  ExecuteOptions,
  FsAdapter,
  InputMessageItem,
  Item,
  MemoryLayer,
  Tool,
} from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/core';
import type { AskUserService } from '../../../tui/services/ask-user-service.js';
import { readChatHistory } from './chat-history-store.js';
import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, loadTask, saveTask } from './fs-store.js';
import { EventKind, TaskPauseReason } from './schemas.js';

//#region Types

export type RunnerRole = 'planner' | 'implementer' | 'validator';

/**
 * Deferred signal a role's terminal tool resolves to end the runner loop.
 * The tool's `execute` fn calls `signal.resolve(outcome)`; the runner
 * awaits `signal.done` and exits with the resolved outcome.
 */
export interface RunnerSignal<TOutcome> {
  readonly done: Promise<TOutcome>;
  resolve(outcome: TOutcome): void;
  reject(err: unknown): void;
}

/**
 * Minimum subset of `AgentHarness` the runner loop calls into. Defining
 * this structurally lets tests pass a stub without `as` casts; the
 * concrete `AgentHarness<{model:string}>` already satisfies the shape.
 */
export interface RunnerLoopHarness {
  seedSessionHistory(threadId: string, history: ReadonlyArray<Item>): void;
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
}

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

//#region Constants

/**
 * Developer-role text the runner sends when an agent finishes a turn
 * without calling either a terminal tool or `AskUserQuestion`. Kept
 * short and unambiguous — the agent should be reminded of its options
 * without being lectured.
 */
const NUDGE_MESSAGE_TEXT =
  'You finished a turn without calling a terminal tool or AskUserQuestion. If you need user input or instruction to continue, call AskUserQuestion now. Otherwise call your terminal tool to complete this phase.';

//#endregion

//#region Public API

/**
 * Construct a deferred-style signal a role's terminal tool resolves on
 * completion. Resolution is single-shot — additional `resolve` / `reject`
 * calls after the first are dropped silently.
 */
export function createRunnerSignal<TOutcome>(): RunnerSignal<TOutcome> {
  let resolveFn: ((outcome: TOutcome) => void) | null = null;
  let rejectFn: ((err: unknown) => void) | null = null;
  const done = new Promise<TOutcome>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    done,
    resolve(outcome) {
      if (resolveFn === null) {
        return;
      }
      const fn = resolveFn;
      resolveFn = null;
      rejectFn = null;
      fn(outcome);
    },
    reject(err) {
      if (rejectFn === null) {
        return;
      }
      const fn = rejectFn;
      resolveFn = null;
      rejectFn = null;
      fn(err);
    },
  };
}

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
      shell: createLocalShellAdapter(),
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
 * the kanban surfaces it. Pure I/O — extracted from `runRunnerLoop` for
 * readability and direct unit testing.
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
 *   1. Seed the session from `<taskDir>/chat.jsonl` so a prior conversation
 *      is restored.
 *   2. **Fresh spawn only** — when chat.jsonl is empty, kick off the first
 *      turn with the role's developer-framing message. The IPC server's
 *      pump persists that message naturally via the item stream, so we
 *      don't double-write to disk.
 *   3. **Resume spawn** — when chat.jsonl already contains items, do NOT
 *      re-execute. The agent already has its prior context replayed; the
 *      next turn is driven by user chat (an IPC `send` frame) or by the
 *      autopilot externally clearing chat.jsonl and respawning.
 *   4. Stall recovery (fresh spawn only, when `nudge` is configured): if
 *      the first turn ends without resolving the signal and without a
 *      pending ask-user request, send one developer-role nudge. If the
 *      second turn also ends in a stall, pause the task with
 *      `pauseReason=agent_stalled` and resolve the signal with
 *      `buildStalledOutcome()` so the runner exits cleanly.
 *   5. Await the role's terminal signal — resolved by a terminal tool
 *      (or rejected externally on SIGTERM).
 *
 * Returns the resolved outcome. If the signal rejects, this rejects with
 * the same reason. Caller is responsible for shutting down the IPC server.
 */
export async function runRunnerLoop<TOutcome>(
  opts: RunRunnerLoopOpts<TOutcome>,
): Promise<TOutcome> {
  const prior: ReadonlyArray<Item> = await readChatHistory(opts.storeCtx, opts.taskId);
  if (prior.length > 0) {
    opts.harness.seedSessionHistory(opts.threadId, prior);
    // Resume path: no kick-off. The agent's prior turns are restored;
    // the next turn comes from user chat or external respawn.
    return opts.signal.done;
  }

  // Track signal settlement without blocking so we can detect stalls
  // (turn ended but signal still pending) without racing the deferred.
  let signalSettled = false;
  void opts.signal.done.then(
    () => {
      signalSettled = true;
    },
    () => {
      signalSettled = true;
    },
  );

  // Fresh path: send the developer-role framing as the first item. The
  // IPC server's pumpItemStream appends it to chat.jsonl when emitted.
  await opts.harness.execute(opts.initialMessage, {
    threadId: opts.threadId,
  });

  // Flush microtasks so the `signal.done.then` callback above reflects
  // any synchronous resolve() that fired during execute().
  await Promise.resolve();

  if (opts.nudge === undefined) {
    return opts.signal.done;
  }

  if (signalSettled) {
    return opts.signal.done;
  }

  if (opts.nudge.askUserService.peek() !== null) {
    // Agent is intentionally awaiting user input via AskUserQuestion.
    return opts.signal.done;
  }

  // Stall — send a single nudge.
  const nudgeMessage: InputMessageItem = {
    id: `runner-nudge-${opts.taskId}-${Date.now()}`,
    type: 'message',
    role: 'developer',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text: NUDGE_MESSAGE_TEXT,
      },
    ],
  };
  await opts.harness.execute(nudgeMessage, {
    threadId: opts.threadId,
  });
  await Promise.resolve();

  if (signalSettled) {
    return opts.signal.done;
  }

  if (opts.nudge.askUserService.peek() !== null) {
    return opts.signal.done;
  }

  // Second stall — escalate.
  await escalateStalledRunner({
    storeCtx: opts.storeCtx,
    taskId: opts.taskId,
    role: opts.nudge.role,
  });
  opts.signal.resolve(opts.nudge.buildStalledOutcome());
  return opts.signal.done;
}

//#endregion
