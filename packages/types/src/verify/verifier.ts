/**
 * The `Verifier` contract (spec 37). `@noetic-tools/core` owns the `verify`
 * step and node and hands the verifier everything it needs — running `act`,
 * listening, reading, storing the run — without importing
 * `@noetic-tools/verify` or `open-verification`. `@noetic-tools/verify`
 * implements this contract; the harness registers it once as
 * `new AgentHarness({ verification: verifier() })`.
 */

import type {
  BlobRef,
  ConnectionEvent,
  ConnectionIdentity,
  ConnectionManifest,
  EventStream,
} from '../types/connection';
import type { Determinism, SenseDescriptor, SenseId } from '../types/profile';
import type {
  Anomaly,
  BlindSpot,
  Claim,
  Constraint,
  ConstraintViolation,
  Ground,
  Repair,
  RunOutcome,
  Verdict,
  VerificationRun,
} from './ovp';

//#region Constants

/** @public The item type a verification run is emitted as (spec 37 § How it runs). */
export const VERIFICATION_RUN_ITEM_TYPE = 'noetic:verification_run';

/** @public `NoeticConfigError` codes for verification (spec 37 § Errors). */
export const VerifyConfigErrorCode = {
  NotConfigured: 'VERIFY_NOT_CONFIGURED',
  Invalid: 'VERIFY_INVALID',
} as const;

/** @public One of `VerifyConfigErrorCode`. */
export type VerifyConfigErrorCode =
  (typeof VerifyConfigErrorCode)[keyof typeof VerifyConfigErrorCode];

/** @public Default quiet period a window waits for (ms). */
export const DEFAULT_VERIFY_QUIET_MS = 500;

/** @public Default window budget (ms). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 15e3;

//#endregion

//#region Writing a verify

/** @public Count bounds a matcher may carry. `count` is exact; `atLeast`/`atMost` bound. */
export interface VerifyCount {
  readonly count?: number;
  readonly atLeast?: number;
  readonly atMost?: number;
}

/**
 * @public
 * One `expect` or `never` entry: a sense and a matcher in that sense's grammar
 * (spec 36 § Senses), or an event type. Built by `net()`, `ui()`, `event()`, …
 * from `@noetic-tools/verify`; written in JSON as `{ "net": "POST /api/orders 201", "count": 1 }`.
 */
export type VerifyMatcher =
  | (VerifyCount & {
      readonly kind: 'sense';
      readonly sense: SenseId;
      /** The matcher text: `'POST /api/orders 201'`, `'heading "Order confirmed"'`, `'cart.total'`. */
      readonly match: string;
      /** A measured value (OVP `measure`). */
      readonly equals?: number | string | boolean;
      readonly tolerance?: number;
    })
  | (VerifyCount & {
      readonly kind: 'event';
      readonly event: string;
    });

/** @public When a window closes. */
export interface VerifyClose {
  /** `'quiet'` → `quiescence`, `'event'` → `signal`, `'done'` → `ack`, `'exit'` → `exit`. */
  readonly until?: 'quiet' | 'event' | 'done' | 'exit';
  /** For `until: 'event'`. */
  readonly event?: string;
  /** Default 500. */
  readonly quietMs?: number;
  /** Default 15e3; reaching it closes the window as `budget-exhausted`. */
  readonly timeoutMs?: number;
}

/** @public A verify as the verifier sees it: claims to make, never `act` itself. */
export interface VerifySpec {
  readonly id: string;
  readonly intent?: string;
  readonly expect?: ReadonlyArray<VerifyMatcher>;
  readonly never?: ReadonlyArray<VerifyMatcher>;
  /** OVP claims given directly, instead of `expect`. */
  readonly claims?: ReadonlyArray<Claim>;
  /** OVP constraints given directly, instead of `never`. */
  readonly constraints?: ReadonlyArray<Constraint>;
  readonly close?: VerifyClose;
}

/** @public What the verifier knows about the subject or a witness before it runs. */
export interface VerifyParticipant {
  /** The harness connection name. */
  readonly name: string;
  readonly role: 'subject' | 'witness';
  readonly identity: ConnectionIdentity;
  readonly manifest: ConnectionManifest;
  /** Sense → descriptor, as the server declares it (defaults applied). */
  readonly senses: Readonly<Record<string, SenseDescriptor>>;
  readonly determinism?: Determinism;
}

/** @public A verify validated and lowered to OVP: what it claims and what it needs to watch. */
export interface PreparedVerify {
  readonly spec: VerifySpec;
  readonly claims: ReadonlyArray<Claim>;
  readonly constraints: ReadonlyArray<Constraint>;
  /** Participant name → senses its claims and constraints read. */
  readonly senses: Readonly<Record<string, ReadonlyArray<SenseId>>>;
  /** Participant name → event types to listen for (matchers, `close.event`). */
  readonly events: Readonly<Record<string, ReadonlyArray<string>>>;
}

//#endregion

//#region Host

/** @public How a long operation started by `act` ended up. */
export interface VerifyActResult {
  /** `act`'s output when it returned. */
  readonly output?: unknown;
  /** Set when `act` threw; the run is still recorded and the step fails with `verify_act_failed`. */
  readonly error?: Error;
  /** Long operations `act` started that were still running when it returned. */
  readonly pendingTasks: ReadonlyArray<{
    readonly connection: string;
    readonly op: string;
    readonly taskId: string;
  }>;
  /** Connections `act` changed; one the verify is not watching adds an `effect-elsewhere` gap. */
  readonly touched: ReadonlyArray<string>;
}

/** @public One gated connection, as the verifier may use it. Witnesses refuse operations with effects. */
export interface VerifyConnection {
  readonly name: string;
  identity(): ConnectionIdentity;
  readonly manifest: ConnectionManifest;
  /** Runs an operation through the harness gates. */
  call(
    op: string,
    args: unknown,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  read(
    resource: string,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  /** Listens for one event type; events arrive with `connection` stamped. */
  listen(req: {
    event: string;
    arguments?: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }): EventStream<ConnectionEvent>;
  /** `noetic://coverage?since=<cursor>`, when the server offers it. */
  coverage?(
    since: string | null,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<ReadonlyArray<BlindSpot>>;
  /** `noetic.detect({ since })`, when the server offers it. */
  detect?(
    since: string | null,
    opts: {
      signal: AbortSignal;
    },
  ): Promise<ReadonlyArray<Anomaly>>;
}

/** @public What core gives the verifier for one run. */
export interface VerifyHost {
  readonly signal: AbortSignal;
  now(): number;
  readonly subject: VerifyConnection;
  readonly witnesses: Readonly<Record<string, VerifyConnection>>;
  /** Runs `act` through the usual gates. Never rejects: a throw is reported as `error`. */
  act(): Promise<VerifyActResult>;
  /** Stores the run document as a blob, attaches it to the trace, and emits `noetic:verification_run`. */
  record(run: VerificationRun): Promise<BlobRef>;
}

//#endregion

//#region Output and contract

/** @public One claim's answer. */
export interface VerifyClaimVerdict {
  readonly claim: string;
  readonly verdict: Verdict;
  readonly ground: Ground;
  readonly reasons: ReadonlyArray<string>;
}

/** @public `step.verify`'s output. `verify` never throws for a `no` or an `unknown`. */
export interface VerifyOutput {
  /** OVP's `outcomeOf(run)`. */
  readonly outcome: RunOutcome;
  readonly verdicts: ReadonlyArray<VerifyClaimVerdict>;
  readonly violations: ReadonlyArray<ConstraintViolation>;
  readonly gaps: ReadonlyArray<BlindSpot>;
  readonly repairs: ReadonlyArray<Repair>;
  /** The stored `VerificationRun`. */
  readonly run: BlobRef;
}

/** @public A verifier implementation (`verifier()` from `@noetic-tools/verify`). */
export interface Verifier {
  readonly name: string;
  readonly version: string;
  /**
   * Validates a verify against its participants and lowers it to OVP claims and
   * constraints. Pure.
   *
   * @throws NoeticConfigError `VERIFY_INVALID` when a matcher cannot be parsed or a
   * witness is asked to act; `CONNECTION_UNSATISFIED` when a matcher needs a sense
   * no participant can perceive.
   */
  prepare(spec: VerifySpec, participants: ReadonlyArray<VerifyParticipant>): PreparedVerify;
  /** Declare, check before, listen, act, close, judge, record (spec 37 § How it runs). */
  run(prepared: PreparedVerify, host: VerifyHost): Promise<VerifyOutput>;
}

//#endregion
