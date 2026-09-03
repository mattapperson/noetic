/**
 * Effect step handler: runs an `effect` step's {@link EffectStepRuntime} under
 * interpreter supervision.
 *
 * Mirrors the sub-harness handler's structure: resolve the runtime (eager or
 * Lazy getter), validate the runtime's shape, apply the optional input schema,
 * run the program with the context's abort signal, then apply the optional
 * output schema. Retry wraps the whole attempt loop so `retry` applies to the
 * program exactly as it does for `runCode` bodies.
 */

import type { ContextData } from '@noetic-tools/context';
import type { Context, EffectStepRuntime, StandardSchemaV1, StepEffect } from '@noetic-tools/types';
import {
  frameworkCast,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
  validateSchema,
} from '@noetic-tools/types';
import { isContextImpl } from './typeguards';

//#region Runtime resolution

/**
 * Resolve the step's runtime, validating the same structural surface the
 * interpreter relies on. Lazy getters are resolved here so a mis-shaped
 * runtime produces the same error whether passed eagerly or as a getter.
 */
async function resolveEffectRuntime<TContext, I, O>(
  step: StepEffect<TContext, I, O>,
  ctx: Context<TContext>,
): Promise<EffectStepRuntime<I, O>> {
  const runtime = typeof step.runtime === 'function' ? await step.runtime(ctx) : step.runtime;
  if (!runtime || typeof runtime.run !== 'function') {
    throw new NoeticConfigError({
      code: 'INVALID_EFFECT_RUNTIME',
      message: `effect step '${step.id}' requires a runtime with a run(input, ctx, signal) function.`,
      hint: 'Pass an EffectStepRuntime, e.g. effectStep(myProgram) from @noetic-tools/effect, or an object { run: (input, ctx, signal) => Promise<output> }.',
    });
  }
  return frameworkCast<EffectStepRuntime<I, O>>(runtime);
}

//#endregion

//#region Execution

/**
 * Executes an `effect` step.
 *
 * The runtime receives the executing context's abort signal so Noetic abort
 * cascades into Effect fiber interruption. Interruption surfaces as a
 * `NoeticError` of kind `cancelled` (the runtime maps it, or the interpreter
 * does below when the abort races the program's completion), and is never
 * retried — cancellation is not a retriable error (spec 09).
 *
 * @param step - The effect step to execute.
 * @param input - Input value passed to the program (validated by
 *   `step.inputSchema` when set).
 * @param ctx - Execution context carrying state, tokens, and observability.
 * @returns The program's (optionally output-validated) result.
 * @throws `NoeticConfigError` with code `INVALID_EFFECT_RUNTIME` if the
 *   resolved runtime has no `run` function.
 * @throws `NoeticError` with kind `cancelled` if the context is aborted.
 * @throws `NoeticError` with kind `step_failed` if the program fails and the
 *   retry policy is exhausted.
 * @internal
 */
export async function executeEffect<TContext = ContextData, I = unknown, O = unknown>(
  step: StepEffect<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<O> {
  const runtime = await resolveEffectRuntime(step, ctx);

  // Optional input validation — same validateSchema path the tool and model
  // handlers use, so Effect Schemas (Standard Schema v1 adapters) work here
  // exactly like Zod schemas.
  let programInput = input;
  if (step.inputSchema) {
    const schema = frameworkCast<StandardSchemaV1<unknown, I>>(step.inputSchema);
    const result = await validateSchema(schema, input);
    if (!result.success) {
      throw new NoeticErrorImpl({
        kind: 'step_failed',
        stepId: step.id,
        cause: new Error(
          `effect step '${step.id}' input failed schema validation: ${result.issues
            .map((i) => `${pathString(i.path)}: ${i.message}`)
            .join('; ')}`,
        ),
        retriesExhausted: false,
      });
    }
    programInput = result.value;
  }

  // The abort signal: ContextImpl fans `abort()` out through this controller,
  // so every blocked operation scoped to this context — including the Effect
  // fiber — is interrupted promptly. Out-of-process contexts have no signal;
  // runtimes must then rely on their own lifecycle management.
  const baseCtx = frameworkCast<Context>(ctx);
  const signal = isContextImpl(baseCtx) ? baseCtx.abortSignal : neverSignal();

  const retry = step.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  let lastError: Error = new Error('No attempts executed');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Cancellation is not a retriable error (spec 09) — an abort that arrived
    // between attempts must stop the loop before re-executing.
    if (ctx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }
    try {
      const run = frameworkCast<
        (input: I, ctx: Context<TContext>, signal: AbortSignal) => Promise<O>
      >(runtime.run);
      const output = await run(programInput, ctx, signal);
      return await validateOutput(step, output);
    } catch (e) {
      // Rethrow cancellation immediately — retrying it would re-run side
      // effects after abort and bury the 'cancelled' kind under step_failed.
      if (isNoeticError(e) && e.noeticError.kind === 'cancelled') {
        throw e;
      }
      if (ctx.aborted) {
        // The runtime rejected for its own reasons while an abort was in
        // flight — cancellation owns the failure surface (spec 09).
        throw new NoeticErrorImpl({
          kind: 'cancelled',
          reason: ctx.abortReason ?? 'context aborted',
        });
      }
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxAttempts - 1 && retry) {
        const delay = computeDelay(retry, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: lastError,
    retriesExhausted: maxAttempts > 1,
  });
}

/** Validates the program result against `step.output` when set. */
async function validateOutput<TContext, I, O>(
  step: StepEffect<TContext, I, O>,
  output: O,
): Promise<O> {
  if (!step.output) {
    return output;
  }
  const schema = frameworkCast<StandardSchemaV1<unknown, O>>(step.output);
  const result = await validateSchema(schema, output);
  if (!result.success) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(
        `effect step '${step.id}' output failed schema validation: ${result.issues
          .map((i) => `${pathString(i.path)}: ${i.message}`)
          .join('; ')}`,
      ),
      retriesExhausted: false,
    });
  }
  return result.value;
}

/** Formats a Standard Schema issue path for error messages. */
function pathString(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): string {
  if (!path || path.length === 0) {
    return '(root)';
  }
  return path
    .map((segment) => {
      if (typeof segment === 'object' && segment !== null && 'key' in segment) {
        return String(frameworkCast<StandardSchemaV1.PathSegment>(segment).key);
      }
      return String(segment);
    })
    .join('.');
}

/**
 * A never-aborting signal for out-of-process contexts (which have no
 * `ContextImpl.abortSignal`). Kept module-level: the signal is inert, so a
 * single shared instance is safe.
 */
let cachedNeverSignal: AbortSignal | undefined;
function neverSignal(): AbortSignal {
  if (!cachedNeverSignal) {
    cachedNeverSignal = new AbortController().signal;
  }
  return cachedNeverSignal;
}

//#endregion

/** Retry backoff delay — identical policy arithmetic to `executeRunCode`. */
function computeDelay(retry: NonNullable<StepEffect['retry']>, attempt: number): number {
  let delay: number;
  switch (retry.backoff) {
    case 'fixed':
      delay = retry.initialDelay;
      break;
    case 'linear':
      delay = retry.initialDelay * (attempt + 1);
      break;
    case 'exponential':
      delay = retry.initialDelay * 2 ** attempt;
      break;
  }
  return Math.min(delay, retry.maxDelay ?? 30_000);
}
