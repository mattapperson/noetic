/**
 * The Open Verification Protocol document types, field for field as
 * `open-verification@1.1.0` defines them (the output types of its Zod
 * schemas), without importing it. A test in `@noetic-tools/verify` checks the
 * two agree. Spec 37 § Under the hood.
 *
 * Noetic calls OVP channels "senses" (spec 36 § Senses); the ids are the same
 * strings, so they cross this boundary unchanged.
 */

//#region Subject

/** @public OVP version a `VerificationRun` declares. */
export const OVP_VERSION = '1.0';

/** @public The kind of place an application runs. Open: any other value is an `x-` surface. */
export const Surface = {
  WEB: 'web',
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
  SERVICE: 'service',
  GAME: 'game',
  DEVICE: 'device',
} as const;

/** @public One of `Surface`. */
export type Surface = (typeof Surface)[keyof typeof Surface];

/** @public The identity of the thing being verified. `instance` changes whenever it is replaced. */
export interface SubjectRef {
  surface: string;
  instance: string;
  epoch?: number;
  locator?: string;
  revision?: string;
}

/** @public What changed between two observations of the same subject. */
export interface Invalidation {
  kind: 'instance' | 'epoch';
  from: string;
  to: string;
}

//#endregion

//#region Channels

/** @public The channels OVP names (Noetic's senses). */
export const ChannelId = {
  UI: 'ui',
  NET: 'net',
  STATE: 'state',
  SIGNAL: 'signal',
  LOG: 'log',
  ROUTE: 'route',
  STORAGE: 'storage',
  TIME: 'time',
  VISUAL: 'visual',
} as const;

/** @public One of `ChannelId`. */
export type ChannelId = (typeof ChannelId)[keyof typeof ChannelId];

/** @public A channel id a realm may declare: named by OVP, or an `x-` extension. */
export type DeclaredChannelId = ChannelId | `x-${string}`;

/** @public Whether a channel can be evidence about the action that produced it. */
export const Independence = {
  INDEPENDENT: 'independent',
  ACTUATION_DERIVED: 'actuation-derived',
} as const;

/** @public One of `Independence`. */
export type Independence = (typeof Independence)[keyof typeof Independence];

/** @public What a channel's evidence is worth. Only `consequence` can buy a `yes`. */
export const Grade = {
  CONSEQUENCE: 'consequence',
  PRESENCE: 'presence',
  CONTEXT: 'context',
} as const;

/** @public One of `Grade`. */
export type Grade = (typeof Grade)[keyof typeof Grade];

/** @public One channel an implementation declares. */
export interface ChannelDescriptor {
  id: string;
  independence: Independence;
  grade: Grade;
  note?: string;
}

//#endregion

//#region Determinism

/** @public What kind of subject this is, in the five ways that change how it may be driven (OVP §10.4). */
export interface DeterminismProfile {
  reset: 'none' | 'cheap' | 'costly';
  replayPrefix: 'free' | 'costly' | 'unsafe';
  time: 'wall' | 'injectable' | 'stepped';
  observation: 'exact' | 'sampled';
  actions: 'reversible' | 'irreversible';
}

/** @public How to get back to step N, derived from the determinism profile. */
export const ResumeStrategy = {
  REPLAY_PREFIX: 'replay-prefix',
  RESET_THEN_REPLAY: 'reset-then-replay',
  REFUSE: 'refuse',
} as const;

/** @public One of `ResumeStrategy`. */
export type ResumeStrategy = (typeof ResumeStrategy)[keyof typeof ResumeStrategy];

//#endregion

//#region Intent, claims, constraints

/** @public Who declared an intent. */
export const IntentOrigin = {
  USER: 'user',
  DEVELOPER: 'developer',
  AGENT: 'agent',
  SYSTEM: 'system',
  WORKFLOW: 'workflow',
  DERIVED: 'derived',
} as const;

/** @public One of `IntentOrigin`. */
export type IntentOrigin = (typeof IntentOrigin)[keyof typeof IntentOrigin];

/** @public An intent's lifecycle state. */
export const IntentStatus = {
  DECLARED: 'declared',
  BOUND: 'bound',
  ABANDONED: 'abandoned',
} as const;

/** @public One of `IntentStatus`. */
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

/** @public Why something should become true. */
export type Intent = {
  id: string;
  statement: string;
  origin: IntentOrigin;
  claims: string[];
  declaredAt?: number;
} & (
  | {
      status: 'abandoned';
      abandonedBecause: string;
    }
  | {
      status: 'declared';
      abandonedBecause?: undefined;
    }
  | {
      status: 'bound';
      abandonedBecause?: undefined;
    }
);

/** @public Whether a claim was written down before or after the action. */
export const Declaration = {
  BEFORE_ACTION: 'before-action',
  AFTER_ACTION: 'after-action',
} as const;

/** @public One of `Declaration`. */
export type Declaration = (typeof Declaration)[keyof typeof Declaration];

/** @public One checkable statement inside a claim. */
export interface Assertion {
  id: string;
  predicate?: unknown;
  reads: string;
  channels: string[];
}

/** @public What must become true. */
export interface Claim {
  id: string;
  intent?: string;
  statement: string;
  declaredAt: Declaration;
  assertions: Assertion[];
}

/** @public What must not happen while the action runs. */
export interface Constraint {
  id: string;
  statement: string;
  predicate?: unknown;
  channels: string[];
  severity: 'blocking' | 'advisory';
}

//#endregion

//#region Predicates

/** @public Selects observations: a channel, optionally a summary and a value substring. */
export type Match = {
  channel: string;
} & (
  | {
      summary: string;
      valueContains: string;
    }
  | {
      summary?: string;
      valueContains?: undefined;
    }
);

/** @public Count comparison operators. */
export const CountOp = {
  EXACTLY: 'exactly',
  AT_LEAST: 'at-least',
  AT_MOST: 'at-most',
} as const;

/** @public One of `CountOp`. */
export type CountOp = (typeof CountOp)[keyof typeof CountOp];

/** @public Measure comparison operators. */
export const MeasureOp = {
  EQUALS: 'equals',
  AT_LEAST: 'at-least',
  AT_MOST: 'at-most',
} as const;

/** @public One of `MeasureOp`. */
export type MeasureOp = (typeof MeasureOp)[keyof typeof MeasureOp];

/** @public Predicate kinds. */
export const PredicateKind = {
  COUNT: 'count',
  PRESENT: 'present',
  ABSENT: 'absent',
  MEASURE: 'measure',
} as const;

/** @public One of `PredicateKind`. */
export type PredicateKind = (typeof PredicateKind)[keyof typeof PredicateKind];

/** @public OVP's predicate language. */
export type Predicate =
  | {
      kind: 'count';
      match: Match;
      op: CountOp;
      value: number;
    }
  | {
      kind: 'present';
      match: Match;
    }
  | {
      kind: 'absent';
      match: Match;
    }
  | {
      kind: 'measure';
      match: Match;
      op: MeasureOp;
      value: number;
      tolerance: number;
    };

//#endregion

//#region Realm surface

/** @public Something a realm can do. */
export interface Capability {
  name: string;
  meaning: string;
  parameters?: unknown;
  mutating: boolean;
}

/** @public Why an action was refused. */
export const RefusalReason = {
  UNDECLARED: 'undeclared',
  UNSUPPORTED: 'unsupported',
  UNRESOLVED: 'unresolved',
  UNAVAILABLE: 'unavailable',
  GUARDED: 'guarded',
  MALFORMED: 'malformed',
} as const;

/** @public One of `RefusalReason`. */
export type RefusalReason = (typeof RefusalReason)[keyof typeof RefusalReason];

/** @public A reference a realm handed out. */
export interface Handle {
  ref: string;
  describes: string;
  at?: string;
}

/** @public An action performed on the subject. */
export interface Action {
  id: string;
  actor: string;
  capability: string;
  target?: string;
  parameters?: unknown;
  at: number;
}

/** @public The record that an action was dispatched (or refused) — never whether it worked. */
export interface ActionReceipt {
  action: string;
  dispatched: boolean;
  refused?: {
    reason: RefusalReason;
    detail: string;
  };
  subject: SubjectRef;
  at: number;
}

/** @public How a window closes. */
export const CloseCondition = {
  QUIESCENCE: 'quiescence',
  TICKS: 'ticks',
  ACK: 'ack',
  SIGNAL: 'signal',
  SETTLED_PHYSICAL: 'settled-physical',
  EXIT: 'exit',
  TERMINATED: 'terminated',
  BUDGET_EXHAUSTED: 'budget-exhausted',
} as const;

/** @public One of `CloseCondition`. */
export type CloseCondition = (typeof CloseCondition)[keyof typeof CloseCondition];

/** @public The stretch of time a verdict is about. */
export interface Window {
  id: string;
  openedAt: number;
  closedAt?: number;
  budgetMs: number;
  closes: CloseCondition;
  closedBy?: CloseCondition;
  subject: SubjectRef;
}

//#endregion

//#region Evidence

/** @public One thing a channel reported. */
export interface Observation {
  id: string;
  window: string;
  channel: string;
  at: number;
  value?: unknown;
  summary: string;
}

/** @public Where a piece of evidence came from. */
export const ProvenanceClass = {
  AUTHORITATIVE: 'authoritative',
  DERIVED: 'derived',
  OBSERVED: 'observed',
  LEARNED: 'learned',
} as const;

/** @public One of `ProvenanceClass`. */
export type ProvenanceClass = (typeof ProvenanceClass)[keyof typeof ProvenanceClass];

/** @public How an observation was obtained. */
export interface Provenance {
  class: ProvenanceClass;
  source: string;
  method: string;
  subject: SubjectRef;
  at: number;
  confidence?: number;
}

/** @public An observation with its provenance, independence and grade. */
export interface Evidence {
  observation: Observation;
  provenance: Provenance;
  independence: Independence;
  grade: Grade;
}

/** @public Kinds of blind spot (Noetic's gaps). */
export const BlindSpotKind = {
  CHANNEL_UNOBSERVED: 'channel-unobserved',
  BOUNDARY_UNCROSSABLE: 'boundary-uncrossable',
  BUFFER_TRUNCATED: 'buffer-truncated',
  REDACTED: 'redacted',
  STILL_IN_FLIGHT: 'still-in-flight',
  EFFECT_ELSEWHERE: 'effect-elsewhere',
} as const;

/** @public One of `BlindSpotKind`. */
export type BlindSpotKind = (typeof BlindSpotKind)[keyof typeof BlindSpotKind];

/** @public Something the verifier could not see (a gap). */
export interface BlindSpot {
  kind: BlindSpotKind;
  channel?: string;
  detail: string;
  impeaching: boolean;
  remedy?: string;
}

/** @public What was observed in a window, and what was not. */
export interface Coverage {
  window: string;
  observed: string[];
  blindSpots: BlindSpot[];
}

//#endregion

//#region Verdicts

/** @public OVP's four answers. Distinct from Noetic's own `Verdict` (spec 05). */
export const Verdict = {
  YES: 'yes',
  NO: 'no',
  UNKNOWN: 'unknown',
  NO_FAULT: 'no-fault',
} as const;

/** @public One of `Verdict`. */
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/** @public Kinds of anomaly. Open: `x-` kinds allowed. */
export const AnomalyKind = {
  ADVANCED_OVER_FAILURE: 'advanced-over-failure',
  CLAIMED_OVER_FAILURE: 'claimed-over-failure',
  EFFECT_DISCARDED: 'effect-discarded',
  CLAIM_UNCORROBORATED: 'claim-uncorroborated',
  FAILURE_INSIDE_SUCCESS: 'failure-inside-success',
  VALUE_NOT_APPLIED: 'value-not-applied',
  DUPLICATED_EFFECT: 'duplicated-effect',
  STALE_APPLIED: 'stale-applied',
  NO_EFFECT: 'no-effect',
  FAULT_MISATTRIBUTED: 'fault-misattributed',
  EVIDENCE_SUPERSEDED: 'evidence-superseded',
  EVIDENCE_PREDATES_EDIT: 'evidence-predates-edit',
} as const;

/** @public One of `AnomalyKind`. */
export type AnomalyKind = (typeof AnomalyKind)[keyof typeof AnomalyKind];

/** @public How an anomaly was established. */
export const AnomalyTier = {
  OBSERVED: 'observed',
  ABSENCE_DERIVED: 'absence-derived',
  ADVISORY: 'advisory',
} as const;

/** @public One of `AnomalyTier`. */
export type AnomalyTier = (typeof AnomalyTier)[keyof typeof AnomalyTier];

/** @public Two channels that cannot both be right. */
export interface Anomaly {
  kind: string;
  tier: AnomalyTier;
  claim: string;
  counter: string;
  between: [
    string,
    string,
  ];
  evidence: string[];
}

/** @public One claim's verdict in one window. */
export interface VerdictRecord {
  id: string;
  claim: string;
  window: string;
  verdict: Verdict;
  grade?: Grade;
  reasons: string[];
  evidence: string[];
  anomalies: Anomaly[];
  supersedes?: string;
  at: number;
}

//#endregion

//#region Run

/** @public A constraint that did not hold. */
export interface ConstraintViolation {
  constraint: string;
  at: number;
  detail: string;
  evidence: string[];
}

/** @public What to fix, for a verdict that was not `yes`. */
export interface Repair {
  verdict: string;
  expected: string;
  actual: string;
  evidence: string[];
  location?: {
    file: string;
    line?: number;
    symbol?: string;
  };
  instruction: string;
}

/** @public A witness listed in a run. */
export interface RunWitness {
  name: string;
  subject: SubjectRef;
  channels: ChannelDescriptor[];
}

/** @public One complete verification, as a document any OVP tool can read. */
export interface VerificationRun {
  ovp: '1.0';
  id: string;
  verifier: {
    name: string;
    version: string;
    profile?: string;
  };
  subject: SubjectRef;
  channels: ChannelDescriptor[];
  witnesses: RunWitness[];
  intents: Intent[];
  claims: Claim[];
  constraints: Constraint[];
  actions: Action[];
  receipts: ActionReceipt[];
  windows: Window[];
  evidence: Evidence[];
  coverage: Coverage[];
  anomalies: Anomaly[];
  verdicts: VerdictRecord[];
  violations: ConstraintViolation[];
  repairs: Repair[];
  startedAt: number;
  endedAt: number;
}

/** @public A run's overall outcome (`outcomeOf(run)`). */
export const RunOutcome = {
  PASS: 'pass',
  FAIL: 'fail',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
} as const;

/** @public One of `RunOutcome`. */
export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

//#endregion

//#region Adjudication

/** @public The deciding clause of a verdict. */
export const Ground = {
  NOTHING_DECLARED: 'nothing-declared',
  CHANNEL_NOT_OBSERVED: 'channel-not-observed',
  CONTRADICTED: 'contradicted',
  ASSERTION_FAILED: 'assertion-failed',
  WINDOW_NOT_CLOSED: 'window-not-closed',
  COVERAGE_IMPEACHED: 'coverage-impeached',
  SUSPICION_UNRESOLVED: 'suspicion-unresolved',
  DECLARED_AFTER_ACTION: 'declared-after-action',
  NO_INDEPENDENT_CONSEQUENCE: 'no-independent-consequence',
  ALREADY_TRUE: 'already-true',
  PROVED: 'proved',
} as const;

/** @public One of `Ground`. */
export type Ground = (typeof Ground)[keyof typeof Ground];

/** @public `adjudicate()`'s answer. */
export interface Adjudication {
  readonly verdict: Verdict;
  readonly grade?: Grade;
  readonly ground: Ground;
  readonly reasons: readonly string[];
}

/** @public `adjudicate()`'s input: one claim and only the evidence on its own senses. */
export interface AdjudicationInput {
  readonly claim: Claim;
  readonly window: Window;
  readonly channels: readonly ChannelDescriptor[];
  readonly evidence: readonly Evidence[];
  readonly coverage: Coverage;
  readonly anomalies: readonly Anomaly[];
  /** Undefined means nothing could evaluate them. */
  readonly assertionsHeld: boolean | undefined;
  /** Undefined means nobody checked. */
  readonly consequenceHeldBefore?: boolean | undefined;
}

/** @public What the subject appeared to claim, and the channel it claimed it on. */
export interface ActorClaim {
  claim: string;
  channel: ChannelId;
}

/** @public What a witness could say about the same moment. */
export interface WitnessReport {
  channel: ChannelId;
  observed: readonly Observation[];
  blind?: readonly BlindSpot[];
}

//#endregion
