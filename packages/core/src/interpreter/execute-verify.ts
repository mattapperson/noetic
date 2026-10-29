/**
 * Runs a `verify` step (spec 37 § How it runs). Core resolves the subject and
 * witnesses through the harness registry, checks that `act` acts, and hands the
 * registered `Verifier` a host; the verifier does the rest in order — declare,
 * check before, listen, act, close, judge, record. A `no` or an `unknown` is an
 * answer: the step only fails when `act` threw (`verify_act_failed`, after the
 * run is recorded) or the verify is misconfigured.
 */

import type {
  Context,
  ExecuteStepFn,
  Step,
  StepConnectionTarget,
  StepVerify,
} from '@noetic-tools/types';
import {
  frameworkCast,
  isNoeticConfigError,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import type { RunOutcome, Verifier, VerifyOutput, VerifySpec } from '@noetic-tools/types/verify';
import { VERIFICATION_RUN_ITEM_TYPE, VerifyConfigErrorCode } from '@noetic-tools/types/verify';
import type { VerifyEachOutput } from '../builders/verify-builder';
import type { ResolvedConnection } from '../connections/registry-types';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import type { ConnectionTargetInfo } from './connection-steps';
import {
  connectionRegistryOf,
  evaluateTarget,
  requirementFor,
  scopeFor,
  signalOf,
  withWitnessGuard,
} from './connection-steps';
import { isStepList, stepChildren } from './step-walk';
import { participantOf, runAct, storeRun, verificationOf, verifyConnectionOf } from './verify-host';

//#region Types

interface Resolved {
  readonly target: ConnectionTargetInfo;
  readonly connection: ResolvedConnection;
}

interface ActCheck {
  /** Connections `act` changes, by name, when they are known statically. */
  readonly touched: ReadonlyArray<string>;
}

//#endregion

//#region Constants

/** Outcomes from best to worst, for a list subject's worst outcome. */
const OUTCOME_RANK: Readonly<Record<RunOutcome, number>> = {
  pass: 0,
  unknown: 1,
  partial: 2,
  fail: 3,
};

/** Step kinds that act on their own: model calls. */
const MODEL_KINDS = new Set<string>([
  'callModel',
  'decide',
  'acp-agent',
]);

//#endregion

//#region Helpers

function isVerifier(value: unknown): value is Verifier {
  return (
    typeof value === 'object' &&
    value !== null &&
    'prepare' in value &&
    typeof value.prepare === 'function' &&
    'run' in value &&
    typeof value.run === 'function'
  );
}

/**
 * The harness's verifier.
 *
 * @throws `NoeticConfigError` `VERIFY_NOT_CONFIGURED` when the harness has none.
 */
function verifierOf(ctx: Context, stepId: string): Verifier {
  const registered = verificationOf(ctx);
  if (isVerifier(registered)) {
    return registered;
  }
  throw new NoeticConfigError({
    code: VerifyConfigErrorCode.NotConfigured,
    message: `Verify '${stepId}' ran, but the harness has no verifier.`,
    hint: "Register one: new AgentHarness({ verification: verifier() }) with verifier from '@noetic-tools/verify'.",
  });
}

function verifyInvalid(stepId: string, message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: VerifyConfigErrorCode.Invalid,
    message: `Verify '${stepId}' ${message}`,
    hint,
  });
}

/** The steps `act` runs on `subject`: a function of the subject is called with its name. */
function actSteps<TContext, I>(
  step: StepVerify<TContext, I, unknown>,
  subject: string,
): ReadonlyArray<Step<TContext, I, unknown>> {
  const act = typeof step.act === 'function' ? step.act(subject) : step.act;
  return isStepList(act)
    ? act
    : [
        act,
      ];
}

/**
 * A list subject runs one verify per connection, so `act` must act on each:
 * a fixed `act` that names one of the subjects would act on that one only while
 * every other verify watched a connection nothing touched.
 *
 * @throws `NoeticConfigError` `VERIFY_INVALID` for such an `act`.
 */
function checkListAct(
  step: StepVerify<unknown, unknown, unknown>,
  subjects: ReadonlyArray<string>,
): void {
  if (typeof step.act === 'function' || subjects.length < 2) {
    return;
  }
  const all = flattenSteps(frameworkCast<ReadonlyArray<Step>>(actSteps(step, '')));
  const named = all
    .filter((s) => s.kind === 'call')
    .map((s) => staticName(frameworkCast<StepConnectionTarget<unknown, unknown>>(s.connection)))
    .find((name) => name !== undefined && subjects.includes(name));
  if (named === undefined) {
    return;
  }
  throw verifyInvalid(
    step.id,
    `has a list subject, but act always acts on '${named}'.`,
    'Make act a function of the subject: act: (subject) => step.call({ connection: subject, ... }).',
  );
}

/** Every step in `act`, nested ones included, as far as they are statically known. */
function flattenSteps(steps: ReadonlyArray<Step>): Step[] {
  return steps.flatMap((s) => [
    s,
    ...flattenSteps(stepChildren(s)),
  ]);
}

/** A `call` step's connection name when it is static; `undefined` when an expression or function picks it. */
function staticName(target: StepConnectionTarget<unknown, unknown>): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  if (typeof target === 'function') {
    return undefined;
  }
  return target.name;
}

/**
 * Checks `act` against the participants' manifests: it must contain an
 * operation with effects or a model call, and must not ask a witness to act.
 *
 * @throws `NoeticConfigError` `VERIFY_INVALID` for either.
 */
function checkAct(opts: {
  step: StepVerify<unknown, unknown, unknown>;
  act: ReadonlyArray<Step>;
  subject: ResolvedConnection;
  witnesses: ReadonlyArray<ResolvedConnection>;
}): ActCheck {
  const { step, act, subject, witnesses } = opts;
  const all = flattenSteps(act);
  const touched = new Set<string>();
  let acts = all.some((s) => MODEL_KINDS.has(s.kind));
  for (const s of all) {
    if (s.kind !== 'call') {
      continue;
    }
    const name = staticName(frameworkCast<StepConnectionTarget<unknown, unknown>>(s.connection));
    const witness = witnesses.find((w) => w.name === name);
    const info = (witness ?? (name === subject.name ? subject : undefined))?.manifest.operations[
      s.op
    ];
    if (witness && (info === undefined || info.effects === true)) {
      throw verifyInvalid(
        step.id,
        `asks witness '${witness.name}' to run '${s.op}' in act.`,
        'A witness can look and cannot touch: act on the subject, or make the connection the subject.',
      );
    }
    const effects = name === undefined || info === undefined || info.effects === true;
    if (!effects) {
      continue;
    }
    acts = true;
    if (name !== undefined) {
      touched.add(name);
    }
  }
  if (!acts) {
    throw verifyInvalid(
      step.id,
      'has nothing in act that acts.',
      'Give act an operation with effects (e.g. ui.tap) or a model call; reads alone cannot cause what the verify checks.',
    );
  }
  return {
    touched: [
      ...touched,
    ],
  };
}

async function resolveOne(opts: {
  ctx: Context;
  stepId: string;
  target: ConnectionTargetInfo;
}): Promise<Resolved> {
  const { ctx, target } = opts;
  const registry = connectionRegistryOf(ctx, target.name);
  const options = target.handle?.options;
  const connection = await registry.resolve({
    name: target.name,
    scope: scopeFor(ctx, options?.fresh),
    requirement: requirementFor(target, {}),
    ...(options?.fresh
      ? {
          fresh: options.fresh,
        }
      : {}),
    ...(options?.from
      ? {
          from: options.from,
        }
      : {}),
    ...(options?.setup
      ? {
          setup: options.setup,
        }
      : {}),
  });
  return {
    target,
    connection,
  };
}

function specOf(step: StepVerify<unknown, unknown, unknown>, id: string): VerifySpec {
  return {
    id,
    ...(step.intent === undefined
      ? {}
      : {
          intent: step.intent,
        }),
    ...(step.expect === undefined
      ? {}
      : {
          expect: step.expect,
        }),
    ...(step.never === undefined
      ? {}
      : {
          never: step.never,
        }),
    ...(step.claims === undefined
      ? {}
      : {
          claims: step.claims,
        }),
    ...(step.constraints === undefined
      ? {}
      : {
          constraints: step.constraints,
        }),
    ...(step.close === undefined
      ? {}
      : {
          close: step.close,
        }),
  };
}

/** Appends the `noetic:verification_run` item (spec 34) and streams it. */
function emitRunItem(opts: {
  ctx: Context;
  stepId: string;
  subject: string;
  output: VerifyOutput;
}): void {
  const { ctx, stepId, subject, output } = opts;
  const item = frameworkCast<Parameters<Context['itemLog']['append']>[0]>({
    id: `item-${crypto.randomUUID()}`,
    type: VERIFICATION_RUN_ITEM_TYPE,
    stepId,
    subject,
    outcome: output.outcome,
    verdicts: output.verdicts,
    violations: output.violations.length,
    gaps: output.gaps.length,
    run: output.run,
  });
  if (ctx instanceof ContextImpl) {
    ctx.allowItemTypes([
      VERIFICATION_RUN_ITEM_TYPE,
    ]);
    ctx.appendEmitted(item);
  } else {
    ctx.itemLog.append(item);
  }
  emitFrameworkEvent({
    broadcaster: getBroadcaster(ctx),
    agentName: ctx.harness.config.name,
    eventType: 'item_appended',
    data: {
      item,
    },
  });
}

/** The `VERIFY_INVALID` an act failure stands for, through any `step_failed` wrapping. */
function verifyInvalidCause(error: unknown): NoeticConfigError | undefined {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return isNoeticConfigError(current) && current.code === VerifyConfigErrorCode.Invalid
    ? current
    : undefined;
}

function worstOutcome(outputs: ReadonlyArray<VerifyOutput>): RunOutcome {
  return outputs.reduce<RunOutcome>(
    (worst, o) => (OUTCOME_RANK[o.outcome] > OUTCOME_RANK[worst] ? o.outcome : worst),
    'pass',
  );
}

//#endregion

//#region Run one subject

async function verifySubject<TContext, I>(opts: {
  step: StepVerify<TContext, I, unknown>;
  id: string;
  subject: ConnectionTargetInfo;
  input: I;
  ctx: Context<TContext>;
  executeStep: ExecuteStepFn;
}): Promise<VerifyOutput> {
  const { step, id, subject, input, ctx, executeStep } = opts;
  const baseCtx = frameworkCast<Context>(ctx);
  const erased = frameworkCast<StepVerify<unknown, unknown, unknown>>(step);
  const verifier = verifierOf(baseCtx, id);
  const resolvedSubject = await resolveOne({
    ctx: baseCtx,
    stepId: id,
    target: subject,
  });
  const witnessTargets = await Promise.all(
    (step.witnesses ?? []).map((w) => evaluateTarget(w, input, ctx, id)),
  );
  const witnesses = await Promise.all(
    witnessTargets.map((target) =>
      resolveOne({
        ctx: baseCtx,
        stepId: id,
        target,
      }),
    ),
  );
  const act = actSteps(step, subject.name);
  const { touched } = checkAct({
    step: erased,
    act: frameworkCast<ReadonlyArray<Step>>(act),
    subject: resolvedSubject.connection,
    witnesses: witnesses.map((w) => w.connection),
  });
  const prepared = verifier.prepare(specOf(erased, id), [
    participantOf(resolvedSubject.connection, 'subject'),
    ...witnesses.map((w) => participantOf(w.connection, 'witness')),
  ]);
  let actError: Error | undefined;
  const output = await verifier.run(prepared, {
    signal: signalOf(baseCtx),
    now: () => Date.now(),
    subject: verifyConnectionOf({
      resolved: resolvedSubject.connection,
      role: 'subject',
      ctx: baseCtx,
      stepId: id,
    }),
    witnesses: Object.fromEntries(
      witnesses.map((w) => [
        w.connection.name,
        verifyConnectionOf({
          resolved: w.connection,
          role: 'witness',
          ctx: baseCtx,
          stepId: id,
        }),
      ]),
    ),
    act: async () => {
      const result = await withWitnessGuard(
        baseCtx,
        witnesses.map((w) => w.connection.name),
        () =>
          runAct({
            steps: act,
            input,
            ctx,
            executeStep,
            touched,
          }),
      );
      actError = result.error;
      return result;
    },
    record: (run) =>
      storeRun({
        ctx: baseCtx,
        stepId: id,
        run,
      }),
  });
  emitRunItem({
    ctx: baseCtx,
    stepId: id,
    subject: resolvedSubject.connection.name,
    output,
  });
  // A witness asked to act is a malformed verify, not a failed action.
  const invalid = verifyInvalidCause(actError);
  if (invalid) {
    throw invalid;
  }
  if (actError) {
    throw new NoeticErrorImpl({
      kind: 'verify_act_failed',
      stepId: id,
      cause: actError,
      run: output.run,
    });
  }
  return output;
}

//#endregion

//#region Public API

/**
 * Executes a `verify` step. With a list subject, runs one verify per connection
 * in parallel (ids `<id>.<name>`) and returns each output with the worst outcome.
 *
 * @throws `NoeticConfigError` `VERIFY_NOT_CONFIGURED` when the harness has no verifier.
 * @throws `NoeticConfigError` `VERIFY_INVALID` when `act` contains nothing that acts, a
 *   matcher cannot be parsed, or a witness is asked to act.
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN`, `CONNECTION_UNSATISFIED` (a sense or
 *   event no participant offers), `CONNECTION_NOT_ALLOWED`, `CONNECTION_INVALID` from resolution.
 * @throws `NoeticErrorImpl` `verify_act_failed` when `act` threw; the run is recorded first.
 */
export async function executeVerify<TContext, I, O>(
  step: StepVerify<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const erased = frameworkCast<StepVerify<TContext, I, unknown>>(step);
  if (!isStepList(step.subject)) {
    const subject = await evaluateTarget(step.subject, input, ctx, step.id);
    const output = await verifySubject({
      step: erased,
      id: step.id,
      subject,
      input,
      ctx,
      executeStep,
    });
    return frameworkCast<O>(output);
  }
  const targets = await Promise.all(
    step.subject.map((s) => evaluateTarget(s, input, ctx, step.id)),
  );
  checkListAct(
    frameworkCast<StepVerify<unknown, unknown, unknown>>(step),
    targets.map((t) => t.name),
  );
  const outputs = await Promise.all(
    targets.map((subject) =>
      verifySubject({
        step: erased,
        id: `${step.id}.${subject.name}`,
        subject,
        input,
        ctx,
        executeStep,
      }),
    ),
  );
  const result: VerifyEachOutput = {
    outcome: worstOutcome(outputs),
    subjects: Object.fromEntries(
      targets.map((t, i) => [
        t.name,
        outputs[i],
      ]),
    ),
  };
  return frameworkCast<O>(result);
}

//#endregion
