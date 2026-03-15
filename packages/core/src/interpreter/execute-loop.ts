import type { StepLoop, Snapshot, Verdict } from '../types/step';
import type { Context } from '../types/context';
import { isOrchidError, OrchidErrorImpl } from '../errors/orchid-error';
import { isMutableContext } from './typeguards';

import type { Step } from '../types/step';

export type ExecuteStepFn = <I, O>(step: Step<I, O>, input: I, ctx: Context) => Promise<O>;

function hasTextField(value: unknown): value is { text: unknown } {
  return typeof value === 'object' && value !== null && 'text' in value;
}

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
  const maxIterations = step.maxIterations ?? 1000;
  const maxHistory = step.maxHistorySize ?? 100;
  let totalIterations = 0;

  // Validate maxIterations
  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    throw new OrchidErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Invalid maxIterations: ${step.maxIterations}`),
      retriesExhausted: false,
    });
  }

  while (true) {
    // Abort check at top of each iteration
    if (ctx.aborted) {
      throw new OrchidErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }

    // Enforce hard iteration ceiling (includes retries)
    totalIterations++;
    if (totalIterations > maxIterations) {
      throw new OrchidErrorImpl({
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
      // Handle error with onError callback
      if (step.onError && isOrchidError(e)) {
        const action = step.onError(e.orchidError, ctx);
        if (action === 'retry') {
          continue; // re-run same iteration (totalIterations already incremented)
        } else if (action === 'skip') {
          stepCount++;
          // Use last successful output if available
          if (lastOutput !== undefined) {
            output = lastOutput;
          } else {
            continue; // skip if no previous output
          }
        } else {
          // abort - propagate error
          throw e;
        }
      } else {
        throw e; // no handler or not an OrchidError
      }
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
    const snapshot: Snapshot & { lastStepMeta?: unknown } = {
      stepCount,
      tokens: { ...ctx.tokens },
      elapsed: Date.now() - startTime,
      cost: ctx.cost,
      lastOutput: output,
      lastText,
      history: [...history],
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
        throw new OrchidErrorImpl({
          kind: 'step_failed',
          stepId: step.id,
          cause: new Error('Loop completed with no successful output'),
          retriesExhausted: false,
        });
      }
      return lastOutput;
    }

    // Prepare input for next iteration
    if (step.prepareNext) {
      currentInput = step.prepareNext(output, verdict, ctx);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- design: output reused as input
      currentInput = output as unknown as I;
    }
  }
}
