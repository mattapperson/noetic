/**
 * Windows (spec 37 § Windows): when listening stops. A window closes by the
 * first of its own condition, a terminating event, or its budget.
 */

import type { CloseCondition, VerifyActResult, VerifyClose } from '@noetic-tools/types/verify';
import { DEFAULT_VERIFY_QUIET_MS, DEFAULT_VERIFY_TIMEOUT_MS } from '@noetic-tools/types/verify';
import { z } from 'zod';
import type { RunState } from './run-state';

//#region Types

/** A window's settings, defaults applied. */
export interface WindowPlan {
  readonly until: NonNullable<VerifyClose['until']>;
  readonly closes: CloseCondition;
  readonly quietMs: number;
  readonly timeoutMs: number;
  readonly event?: string;
}

/** Resolves the window early: a close event, an exit, a termination. */
export interface CloseTrigger {
  readonly promise: Promise<CloseCondition>;
  fire(by: CloseCondition): void;
}

//#endregion

//#region Constants

const UNTIL_TO_CLOSE: Readonly<Record<WindowPlan['until'], CloseCondition>> = {
  quiet: 'quiescence',
  event: 'signal',
  done: 'ack',
  exit: 'exit',
};

const SETTLE_OP = 'ui.settle';

const SettleResultSchema = z
  .object({
    closedBy: z.enum([
      'quiescence',
      'signal',
      'budget-exhausted',
    ]),
    unmeasurable: z.boolean().optional(),
  })
  .loose();

//#endregion

//#region Helpers

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      {
        once: true,
      },
    );
  });
}

/** Never closes the window on its own: `event`, `exit` and outstanding `done` close by trigger or budget. */
function untilAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    signal.addEventListener('abort', () => resolve(undefined), {
      once: true,
    });
  });
}

/** Resolves `quiescence` once nothing has arrived for `quietMs`. */
async function internalQuiet(
  state: RunState,
  plan: WindowPlan,
  signal: AbortSignal,
): Promise<CloseCondition | undefined> {
  const step = Math.max(5, Math.min(plan.quietMs, 50));
  while (!signal.aborted) {
    if (state.host.now() - state.lastActivity >= plan.quietMs) {
      return 'quiescence';
    }
    await sleep(step, signal);
  }
  return undefined;
}

/** Quiet as the subject's `ui.settle` reports it, or as observed arrivals show it when there is no settle. */
async function quiet(
  state: RunState,
  plan: WindowPlan,
  signal: AbortSignal,
): Promise<CloseCondition | undefined> {
  const subject = state.subject.connection;
  if (subject.manifest.operations[SETTLE_OP] === undefined) {
    return internalQuiet(state, plan, signal);
  }
  let raw: unknown;
  try {
    raw = await subject.call(
      SETTLE_OP,
      {
        until: 'quiet',
        quietMs: plan.quietMs,
        timeoutMs: plan.timeoutMs,
      },
      {
        signal,
      },
    );
  } catch {
    return internalQuiet(state, plan, signal);
  }
  const settled = SettleResultSchema.safeParse(raw);
  if (!settled.success) {
    return internalQuiet(state, plan, signal);
  }
  if (settled.data.unmeasurable === true) {
    state.gap(
      'channel-unobserved',
      'the subject could not measure quiet; the window closed after quietMs with no events',
      {
        channel: 'time',
        impeaching: false,
      },
    );
  }
  return settled.data.closedBy;
}

function untilCondition(opts: {
  state: RunState;
  plan: WindowPlan;
  act: VerifyActResult;
  signal: AbortSignal;
}): Promise<CloseCondition | undefined> {
  const { state, plan, act, signal } = opts;
  if (plan.until === 'quiet') {
    return quiet(state, plan, signal);
  }
  if (plan.until === 'done' && act.pendingTasks.length === 0) {
    return Promise.resolve('ack');
  }
  return untilAborted(signal);
}

//#endregion

//#region Public API

/** A window's settings from `close`, defaults applied (quiet for 500 ms, at most 15 s). */
export function planWindow(close: VerifyClose | undefined): WindowPlan {
  const until = close?.until ?? 'quiet';
  return {
    until,
    closes: UNTIL_TO_CLOSE[until],
    quietMs: close?.quietMs ?? DEFAULT_VERIFY_QUIET_MS,
    timeoutMs: close?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    ...(close?.event === undefined
      ? {}
      : {
          event: close.event,
        }),
  };
}

/** A trigger that resolves once, with the first condition fired. */
export function closeTrigger(): CloseTrigger {
  let fire: (by: CloseCondition) => void = () => undefined;
  const promise = new Promise<CloseCondition>((resolve) => {
    fire = resolve;
  });
  return {
    promise,
    fire: (by) => fire(by),
  };
}

/**
 * Waits for the window to close and returns how it closed. The budget counts
 * from when `act` returned; reaching it closes the window as `budget-exhausted`.
 */
export async function waitForClose(opts: {
  state: RunState;
  plan: WindowPlan;
  act: VerifyActResult;
  trigger: CloseTrigger;
}): Promise<CloseCondition> {
  const { state, plan, act, trigger } = opts;
  const controller = new AbortController();
  const abortOnHost = (): void => controller.abort();
  state.host.signal.addEventListener('abort', abortOnHost, {
    once: true,
  });
  const budget = sleep(plan.timeoutMs, controller.signal).then(
    (): CloseCondition => 'budget-exhausted',
  );
  const aborted = new Promise<CloseCondition>((resolve) => {
    if (state.host.signal.aborted) {
      resolve('terminated');
      return;
    }
    state.host.signal.addEventListener('abort', () => resolve('terminated'), {
      once: true,
    });
  });
  const own = untilCondition({
    state,
    plan,
    act,
    signal: controller.signal,
  }).then((by) => by ?? 'budget-exhausted');
  try {
    return await Promise.race([
      trigger.promise,
      own,
      budget,
      aborted,
    ]);
  } finally {
    controller.abort();
    state.host.signal.removeEventListener('abort', abortOnHost);
  }
}

//#endregion
