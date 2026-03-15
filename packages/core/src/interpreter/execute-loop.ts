import type { StepLoop, Snapshot, Verdict } from '../types/step';
import type { Context } from '../types/context';
import type { OrchidError } from '../types/error';
import { OrchidErrorImpl, isOrchidError } from '../errors/orchid-error';

export type ExecuteStepFn = <I, O>(step: any, input: I, ctx: Context) => Promise<O>;

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

  while (true) {
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
          continue; // re-run same iteration
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

    // Extract text from output for snapshot
    if (typeof output === 'string') {
      lastText = output;
    } else if (output && typeof output === 'object' && 'text' in (output as any)) {
      lastText = String((output as any).text);
    } else {
      lastText = typeof output === 'undefined' ? '' : JSON.stringify(output);
    }

    // Build snapshot
    const snapshot: Snapshot & { lastStepMeta?: any } = {
      stepCount,
      tokens: { ...ctx.tokens },
      elapsed: Date.now() - startTime,
      cost: ctx.cost,
      lastOutput: output,
      lastText,
      history: [...history],
      depth: ctx.depth,
      lastStepMeta: (ctx as any).lastStepMeta,
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
      return lastOutput!;
    }

    // Prepare input for next iteration
    if (step.prepareNext) {
      currentInput = step.prepareNext(output, verdict, ctx);
    } else {
      currentInput = output as unknown as I;
    }
  }
}
