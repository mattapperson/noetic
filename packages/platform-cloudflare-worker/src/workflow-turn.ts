/**
 * The Cloudflare Workflows preset (spec 25 § Cloudflare Workers): one Workflow
 * instance per turn. The instance runs the turn until it parks, then sleeps until
 * the turn's deadline or a wake event, then runs it again, until it ends.
 *
 * The Workflow only decides when the harness runs. What the turn did is in the
 * harness's own storage, so a Workflow step that is retried, or a turn woken
 * twice, replays from the step ledger and repeats nothing.
 */

import type { AgentHarness, ExecuteInput, ExecuteOptions } from '@noetic-tools/core';

//#region Types

/** @public The part of a Workflow's `step` this preset uses. A `WorkflowStep` fits. */
export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  waitForEvent(
    name: string,
    options: {
      type: string;
      timeout?: number | string;
    },
  ): Promise<unknown>;
}

/** @public The part of a Workflow instance this preset uses. */
export interface WorkflowInstanceLike {
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
}

/** @public The part of a Workflow binding this preset uses. Pass `env.TURNS`. */
export interface WorkflowBindingLike<P> {
  create(options: { id: string; params: P }): Promise<WorkflowInstanceLike>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

/** @public The params of a turn's Workflow instance: what `startTurn` passes to `create`. */
export interface TurnParams {
  threadId: string;
  /** The message's id on the platform it came from. A message delivered twice is one turn. */
  messageId: string;
  input: ExecuteInput;
}

/** @public The harness methods the Workflows preset calls. An `AgentHarness` fits. */
export type TurnHarness = Pick<AgentHarness, 'execute' | 'wake' | 'getAgentResponse'>;

/** @public Options for `runTurn`. */
export interface RunTurnOptions {
  harness: TurnHarness;
  /** The `step` the Workflow's `run` was given. */
  step: WorkflowStepLike;
  /** The instance's params: `event.payload`. */
  turn: TurnParams;
  /** `execute()` options the turn runs with, on its first run and every run after a wake. */
  options?: Omit<ExecuteOptions, 'threadId' | 'messageId'>;
  /**
   * The longest one sleep lasts when the turn has no deadline of its own, such as
   * one waiting on a held tool call. Default 24 hours; a Workflow waits a year at most.
   */
  maxWaitMs?: number;
  now?: () => number;
}

/** @public How a turn's Workflow instance ended. */
export interface TurnOutcome {
  /** The turn's answer. Empty when `gone`. */
  text: string;
  /**
   * True when the turn was no longer there to wake: another message replaced it,
   * the host abandoned it, or it is stuck and waiting for the host.
   */
  gone?: boolean;
}

/** One run of the turn, as a Workflow step records it. */
interface TurnRun {
  text: string;
  parked?: {
    wakeAt?: number;
  };
  gone?: boolean;
}

//#endregion

//#region Constants

/** @public The event type that wakes a turn's Workflow instance. */
export const TURN_WAKE_EVENT = 'noetic-wake';

/** @public The longest one sleep lasts when the turn has no deadline, by default. */
export const DEFAULT_MAX_WAIT_MS = 24 * 36e5;

/** A Workflow instance id is at most 100 characters of letters, digits, `-` and `_`. */
const INSTANCE_ID_MAX = 100;
const INSTANCE_ID_UNSAFE = /[^a-zA-Z0-9_-]/g;
const SHORTEST_WAIT_MS = 1e3;
const HASH_CHARS = 16;

//#endregion

//#region Helpers

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [
    ...new Uint8Array(digest),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HASH_CHARS);
}

/** How long to sleep before the next run: until the deadline, or `maxWaitMs` with none. */
function waitFor(run: TurnRun, options: RunTurnOptions): number {
  const longest = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const wakeAt = run.parked?.wakeAt;
  if (wakeAt === undefined) {
    return longest;
  }
  const now = (options.now ?? Date.now)();
  return Math.min(longest, Math.max(SHORTEST_WAIT_MS, wakeAt - now));
}

async function answerOf(harness: TurnHarness, threadId: string): Promise<TurnRun> {
  const response = await harness.getAgentResponse({
    threadId,
  });
  return {
    text: response.text,
    ...(response.parked
      ? {
          parked: response.parked,
        }
      : {}),
  };
}

async function firstRun(options: RunTurnOptions): Promise<TurnRun> {
  const { threadId, messageId, input } = options.turn;
  await options.harness.execute(input, {
    ...options.options,
    threadId,
    messageId,
  });
  return answerOf(options.harness, threadId);
}

async function wokenRun(options: RunTurnOptions): Promise<TurnRun> {
  const { threadId } = options.turn;
  const woken = await options.harness.wake({
    threadId,
    options: options.options,
  });
  if (woken.length === 0) {
    return {
      text: '',
      gone: true,
    };
  }
  return answerOf(options.harness, threadId);
}

/** Sleeps until the wake event or the deadline, whichever is first. */
async function sleep(step: WorkflowStepLike, name: string, ms: number): Promise<void> {
  try {
    await step.waitForEvent(name, {
      type: TURN_WAKE_EVENT,
      timeout: ms,
    });
  } catch {
    // A Workflow raises when the wait times out: the deadline came with no event.
  }
}

//#endregion

//#region Public API

/**
 * @public
 * The id of the Workflow instance that runs a turn. The same thread and message
 * give the same id, so a message delivered twice starts one instance.
 */
export async function turnInstanceId(threadId: string, messageId: string): Promise<string> {
  const plain = `${threadId}-${messageId}`;
  const safe = plain.replace(INSTANCE_ID_UNSAFE, '_').replace(/^-/, '_');
  if (safe === plain && safe.length <= INSTANCE_ID_MAX) {
    return safe;
  }
  // Something was replaced or cut: add a hash so two different turns cannot collide.
  const hash = await shortHash(plain);
  return `${safe.slice(0, INSTANCE_ID_MAX - HASH_CHARS - 1)}_${hash}`;
}

/**
 * @public
 * Run a turn to its end from inside a Workflow's `run`. Call it with the `step`
 * and `event.payload` the Workflow was given, and return what it resolves.
 *
 * @example
 * ```ts
 * export class Turns extends WorkflowEntrypoint<Env, TurnParams> {
 *   async run(event: WorkflowEvent<TurnParams>, step: WorkflowStep) {
 *     return runTurn({ harness: buildHarness(this.env), step, turn: event.payload });
 *   }
 * }
 * ```
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnOutcome> {
  const { step } = options;
  let run = await step.do('turn-0', () => firstRun(options));
  for (let n = 1; run.parked; n += 1) {
    await sleep(step, `wait-${n}`, waitFor(run, options));
    run = await step.do(`turn-${n}`, () => wokenRun(options));
  }
  return {
    text: run.text,
    ...(run.gone
      ? {
          gone: true,
        }
      : {}),
  };
}

/**
 * @public
 * Start the Workflow instance for a message's turn. A message delivered again
 * finds the instance it already started. Resolves the instance id.
 */
export async function startTurn(
  binding: WorkflowBindingLike<TurnParams>,
  turn: TurnParams,
): Promise<string> {
  const id = await turnInstanceId(turn.threadId, turn.messageId);
  try {
    await binding.create({
      id,
      params: turn,
    });
  } catch (error) {
    // `create` throws for an id that exists; anything else is a real failure.
    await binding.get(id).catch(() => {
      throw error;
    });
  }
  return id;
}

/**
 * @public
 * Wake a turn's Workflow instance before its deadline: the event it waits for
 * arrived, or a person answered a held call. An event sent before the instance
 * reaches its wait is kept for it.
 */
export async function wakeTurn(
  binding: WorkflowBindingLike<TurnParams>,
  instanceId: string,
): Promise<void> {
  const instance = await binding.get(instanceId);
  await instance.sendEvent({
    type: TURN_WAKE_EVENT,
    payload: {},
  });
}

//#endregion
