/**
 * `step.verify` (spec 37): checks, from outside the thing making the claim,
 * that an action did what it should — it says what should become true, runs
 * `act` on a real connection, watches what the connection's senses report,
 * and answers yes, no, unknown or no-fault with the evidence and the gaps.
 *
 * Core owns the step; the verifier that judges it is registered on the harness
 * (`new AgentHarness({ verification: verifier() })`), so core never imports
 * `@noetic-tools/verify` or `open-verification`.
 */

import type { ContextData } from '@noetic-tools/context';
import type {
  ConnectionHandle,
  CustomItemMap,
  StepEmitItemsOption,
  StepReplay,
  StepVerify,
  StepVerifyAct,
  StepVerifySubject,
} from '@noetic-tools/types';
import { NoeticConfigError } from '@noetic-tools/types';
import type {
  Claim,
  Constraint,
  RunOutcome,
  VerifyClose,
  VerifyMatcher,
  VerifyOutput,
} from '@noetic-tools/types/verify';
import { VerifyConfigErrorCode } from '@noetic-tools/types/verify';
import { getDefaultRegistrar } from '../types/step-registrar';

//#region Types

/**
 * @public
 * An `expect` or `never` entry: a plain matcher, or a builder from
 * `@noetic-tools/verify` (`net('POST /api/orders 201').once()`), which carries
 * its matcher as `matcher`.
 */
export type VerifyMatcherLike =
  | VerifyMatcher
  | {
      readonly matcher: VerifyMatcher;
    };

/** @public A connection named in `subject` or `witnesses`: a handle, or a harness connection name. */
export type VerifyConnectionRef = ConnectionHandle | string;

/** @public `step.verify`'s options (spec 37 § Writing a verify). */
export interface VerifyOpts<TContext = ContextData, I = unknown> extends StepReplay<TContext, I> {
  id: string;
  /** The connection checked — or a list, which runs one verify per connection in parallel. */
  subject: StepVerifySubject<TContext, I>;
  /** What must become true. Exactly one of `expect` or `claims`. */
  expect?: ReadonlyArray<VerifyMatcherLike>;
  /** What must not happen at any point while the action runs. */
  never?: ReadonlyArray<VerifyMatcherLike>;
  /** OVP claims given directly, instead of `expect`. */
  claims?: ReadonlyArray<Claim>;
  /** OVP constraints given directly, instead of `never`. */
  constraints?: ReadonlyArray<Constraint>;
  /**
   * The action: a step, or an array of steps run in sequence — or, for a list
   * subject, `(subject) => steps` giving each subject's action.
   */
  act: StepVerifyAct<TContext, I>;
  /** Connections that can confirm from outside the subject. */
  witnesses?: ReadonlyArray<VerifyConnectionRef>;
  /** When to stop watching. Default: quiet for 500 ms, at most 15 s. */
  close?: VerifyClose;
  /** A sentence saying why, kept in the run record. */
  intent?: string;
  emitItems?: StepEmitItemsOption<TContext, I, unknown>;
  customItems?: CustomItemMap;
}

/**
 * @public
 * The output of a verify whose subject is a list: one verify per connection,
 * with ids `<id>.<name>`, and the worst outcome among them.
 */
export interface VerifyEachOutput {
  readonly outcome: RunOutcome;
  /** Connection name → that connection's verify output. */
  readonly subjects: Readonly<Record<string, VerifyOutput>>;
}

//#endregion

//#region Helpers

function invalid(id: string, message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: VerifyConfigErrorCode.Invalid,
    message: `step.verify(${JSON.stringify(id)}) ${message}`,
    hint,
  });
}

/** The plain matcher an `expect`/`never` entry stands for. */
export function plainMatcher(entry: VerifyMatcherLike): VerifyMatcher {
  return 'matcher' in entry ? entry.matcher : entry;
}

function checkOpts<TContext, I>(opts: VerifyOpts<TContext, I>): void {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'step.verify() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. step.verify({ id: "checkout", ... }).',
    });
  }
  if ((opts.expect === undefined) === (opts.claims === undefined)) {
    throw invalid(
      opts.id,
      'needs exactly one of expect (matchers) or claims (OVP claims).',
      "Say what must become true with expect: [net('POST /api/orders 201')], or give OVP claims.",
    );
  }
  if (opts.never !== undefined && opts.constraints !== undefined) {
    throw invalid(
      opts.id,
      'takes never (matchers) or constraints (OVP constraints), not both.',
      'Keep one of the two.',
    );
  }
  // A function of the subject builds its steps when the verify runs; they are checked then.
  if (typeof opts.act !== 'function' && Array.isArray(opts.act) && opts.act.length === 0) {
    throw invalid(
      opts.id,
      'has nothing in act.',
      'Give act the step that performs the action: an operation with effects or a model call.',
    );
  }
  if (Array.isArray(opts.subject) && opts.subject.length === 0) {
    throw invalid(opts.id, 'has an empty subject list.', 'Name at least one connection to check.');
  }
}

//#endregion

//#region Public API

/**
 * Creates a verify step (spec 37). `expect` and `never` lower to OVP claims and
 * constraints; OVP's `adjudicate()` decides each verdict. Its output's
 * `outcome` is `pass`, `fail`, `partial` or `unknown` — a `no` or an `unknown`
 * is an answer, never an error.
 *
 * @public
 * @returns A `StepVerify`, auto-registered in the step registry. With a list
 *   subject its output is a `VerifyEachOutput`, otherwise a `VerifyOutput`.
 * @throws `NoeticConfigError` `EMPTY_STEP_ID`; `VERIFY_INVALID` without exactly one
 *   of `expect`/`claims`, with both `never` and `constraints`, or with an empty `act`.
 */
export function verify<TContext = ContextData, I = unknown>(
  opts: VerifyOpts<TContext, I> & {
    subject: ReadonlyArray<VerifyConnectionRef>;
  },
): StepVerify<TContext, I, VerifyEachOutput>;
export function verify<TContext = ContextData, I = unknown>(
  opts: VerifyOpts<TContext, I>,
): StepVerify<TContext, I, VerifyOutput>;
export function verify<TContext = ContextData, I = unknown>(
  opts: VerifyOpts<TContext, I>,
): StepVerify<TContext, I, VerifyOutput | VerifyEachOutput> {
  checkOpts(opts);
  const { expect, never, ...rest } = opts;
  const built: StepVerify<TContext, I, VerifyOutput | VerifyEachOutput> = {
    kind: 'verify',
    ...rest,
    ...(expect === undefined
      ? {}
      : {
          expect: expect.map(plainMatcher),
        }),
    ...(never === undefined
      ? {}
      : {
          never: never.map(plainMatcher),
        }),
  };
  getDefaultRegistrar().register(built);
  return built;
}

//#endregion
