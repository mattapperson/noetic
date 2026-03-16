import { isNoeticError, NoeticErrorImpl } from '../errors/noetic-error';
import type { Context } from '../types/context';
import type { ExecuteStepFn, Snapshot, StepLoop, Verdict } from '../types/step';
import { createMessage } from './message-helpers';
import { isMutableContext } from './typeguards';

//#region Types

type InboxFields = Pick<StepLoop<unknown, unknown>, 'inbox' | 'parkTimeout'>;

//#endregion

//#region Helper Functions

function hasTextField(value: unknown): value is {
  text: unknown;
} {
  return typeof value === 'object' && value !== null && 'text' in value;
}

async function recvInboxWithTimeout(ctx: Context, step: InboxFields): Promise<string | null> {
  if (!step.inbox) {
    return null;
  }
  if ((step.parkTimeout ?? 0) <= 0) {
    return ctx.tryRecv(step.inbox);
  }
  try {
    return await ctx.recv(step.inbox, {
      timeout: step.parkTimeout,
    });
  } catch {
    // Expected: channel_timeout error when parkTimeout expires with no message.
    return null;
  }
}

function prepareNextInput<I, O>(
  step: StepLoop<I, O>,
  lastOutput: O,
  verdict: Verdict,
  ctx: Context,
): I {
  if (step.prepareNext) {
    return step.prepareNext(lastOutput, verdict, ctx);
  }
  // SAFETY: requires I === O when prepareNext is omitted — the loop feeds output
  // back as input. Callers must ensure I and O are compatible types.
  return lastOutput as unknown as I;
}

//#endregion

//#region Public API

export async function executeLoop<I, O>(
  step: StepLoop<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
): Promise<O> {
  let currentInput: I = input;
  let lastOutput: O | undefined;
  let lastText = '';
  const history: unknown[] = [];
  const startTime = Date.now();
  let stepCount = 0;
  const maxIterations = step.maxIterations ?? 1e3;
  const maxHistory = step.maxHistorySize ?? 100;
  let totalIterations = 0;

  // Validate maxIterations
  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Invalid maxIterations: ${step.maxIterations}`),
      retriesExhausted: false,
    });
  }

  while (true) {
    // Abort check at top of each iteration
    if (ctx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }

    // Enforce hard iteration ceiling (includes retries)
    totalIterations++;
    if (totalIterations > maxIterations) {
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: step.id,
        cause: new Error(`Loop exceeded maximum iterations (${maxIterations})`),
        retriesExhausted: false,
      });
    }

    // Execute the body step
    let output: O;
    try {
      output = await executeStep<I, O>(step.body, currentInput, ctx);
      stepCount++;
    } catch (e) {
      if (!step.onError || !isNoeticError(e)) {
        throw e;
      }
      const action = step.onError(e.noeticError, ctx);
      if (action === 'retry') {
        continue;
      }
      if (action !== 'skip') {
        throw e;
      }
      stepCount++;
      if (lastOutput === undefined) {
        continue;
      }
      output = lastOutput;
    }

    lastOutput = output;
    history.push(output);

    // Trim history if it exceeds maxHistorySize
    if (history.length > maxHistory) {
      history.splice(0, history.length - maxHistory);
    }

    // Extract text from output for snapshot
    if (typeof output === 'string') {
      lastText = output;
    } else if (hasTextField(output)) {
      lastText = String(output.text);
    } else {
      lastText = output === undefined ? '' : JSON.stringify(output);
    }

    // Build snapshot
    const snapshot: Snapshot = {
      stepCount,
      tokens: {
        ...ctx.tokens,
      },
      elapsed: Date.now() - startTime,
      cost: ctx.cost,
      lastOutput: output,
      lastText,
      history: [
        ...history,
      ],
      depth: ctx.depth,
      lastStepMeta: isMutableContext(ctx) ? ctx.lastStepMeta : null,
    };

    // Evaluate until predicate
    let verdict: Verdict;
    try {
      verdict = await step.until(snapshot);
    } catch (predicateError) {
      // Per spec: if until predicate throws, treat as stop
      verdict = {
        stop: true,
        reason: `Predicate error: ${predicateError instanceof Error ? predicateError.message : String(predicateError)}`,
      };
    }

    if (verdict.stop) {
      if (lastOutput === undefined) {
        throw new NoeticErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('Loop completed with no successful output'),
          retriesExhausted: false,
        });
      }

      // Check inbox before truly stopping
      if (step.inbox) {
        const inboxMessage = await recvInboxWithTimeout(ctx, step);
        if (inboxMessage !== null) {
          ctx.itemLog.append(createMessage(inboxMessage, 'developer'));
          // Continue the loop — don't stop
          currentInput = prepareNextInput(step, lastOutput, verdict, ctx);
          continue;
        }
      }

      return lastOutput;
    }

    // Prepare input for next iteration
    currentInput = prepareNextInput(step, output, verdict, ctx);
  }
}

//#endregion
