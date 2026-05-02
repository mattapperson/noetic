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
 */

import type { FsAdapter, InputMessageItem, Item, MemoryLayer, Tool } from '@noetic/core';
import { AgentHarness, createLocalShellAdapter, step } from '@noetic/core';
import { readChatHistory } from './chat-history-store.js';
import type { TaskStoreContext } from './fs-store.js';

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

export interface RunRunnerLoopOpts<TOutcome> {
  readonly harness: AgentHarness<{
    model: string;
  }>;
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
}

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
export function createRunnerHarness(opts: RunnerHarnessOpts): RunnerHarnessResult {
  const harness = new AgentHarness({
    name: `noetic-${opts.role}`,
    fs: opts.fs,
    shell: createLocalShellAdapter(),
    params: {
      model: opts.model,
    },
    initialStep: step.llm({
      id: `${opts.role}-chat`,
      model: opts.model,
      instructions: opts.instructions,
      tools: [
        ...opts.tools,
      ],
    }),
    memory: [
      ...opts.memory,
    ],
    llm: {
      provider: 'openrouter',
      apiKey: opts.apiKey,
    },
    initialCwd: opts.cwd,
  });

  const threadId = `noetic-${opts.role}-${opts.taskId}-${Date.now()}`;

  return {
    harness,
    threadId,
  };
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
 *   4. Await the role's terminal signal — resolved by a terminal tool
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
  // Fresh path: send the developer-role framing as the first item. The
  // IPC server's pumpItemStream appends it to chat.jsonl when emitted.
  await opts.harness.execute(opts.initialMessage, {
    threadId: opts.threadId,
  });
  return opts.signal.done;
}

//#endregion
