/**
 * `prepare()`: validates a verify against its participants and lowers `expect`
 * and `never` to OVP claims and constraints (spec 37 § The full OVP form).
 * Each `expect` entry becomes a claim with one assertion — its sense as the
 * channel, its matcher as the predicate, a generated statement — and each
 * `never` entry a blocking constraint.
 */

import type { ConnectionMissing, SenseId } from '@noetic-tools/types';
import { ConnectionUnsatisfiedError, isSenseId } from '@noetic-tools/types';
import type {
  Assertion,
  Claim,
  Constraint,
  PreparedVerify,
  VerifyMatcher,
  VerifyParticipant,
  VerifySpec,
} from '@noetic-tools/types/verify';
import { OvpClaimSchema, OvpConstraintSchema } from '@noetic-tools/types/verify';
import { verifyInvalid } from './errors';
import { compileMatcher } from './grammar';
import { toVerifyMatcher } from './matchers';
import type { CountBound } from './predicates';

//#region Types

interface Lowered {
  /** The sense the matcher reads (for an event, the event's sense). */
  readonly channel: string;
  /** One predicate per bound; together they must all hold. */
  readonly predicates: ReadonlyArray<unknown>;
  /** The matcher in words. */
  readonly reads: string;
  /** The participant whose event an event matcher names. */
  readonly eventOf?: {
    readonly participant: string;
    readonly event: string;
  };
}

//#endregion

//#region Helpers

function boundsOf(m: VerifyMatcher): CountBound[] {
  const bounds: CountBound[] = [];
  if (m.count !== undefined) {
    bounds.push({
      op: 'exactly',
      value: m.count,
    });
  }
  if (m.atLeast !== undefined) {
    bounds.push({
      op: 'at-least',
      value: m.atLeast,
    });
  }
  if (m.atMost !== undefined) {
    bounds.push({
      op: 'at-most',
      value: m.atMost,
    });
  }
  return bounds;
}

function boundsText(bounds: ReadonlyArray<CountBound>): string {
  return bounds
    .map((b) => {
      if (b.op === 'exactly') {
        return b.value === 1 ? 'exactly once' : `exactly ${b.value} times`;
      }
      return `${b.op.replace('-', ' ')} ${b.value} times`;
    })
    .join(' and ');
}

function describeMatcher(m: VerifyMatcher): string {
  const bounds = boundsText(boundsOf(m));
  const suffix = bounds.length > 0 ? ` ${bounds}` : '';
  if (m.kind === 'event') {
    return `event ${m.event}${suffix}`;
  }
  const value =
    m.equals === undefined
      ? ''
      : ` equal to ${JSON.stringify(m.equals)}${m.tolerance ? ` (±${m.tolerance})` : ''}`;
  return `${m.sense} ${m.match}${value}${suffix}`;
}

function eventChannel(
  m: Extract<
    VerifyMatcher,
    {
      kind: 'event';
    }
  >,
  participants: ReadonlyArray<VerifyParticipant>,
  subject: VerifyParticipant,
): Lowered {
  const owner = participants.find((p) => p.manifest.events[m.event] !== undefined);
  if (!owner) {
    throw unsatisfied(subject.name, {
      kind: 'event',
      event: m.event,
    });
  }
  const channel = owner.manifest.events[m.event]?.sense ?? 'signal';
  if (owner.senses[channel] === undefined) {
    throw unsatisfied(owner.name, {
      kind: 'sense',
      sense: channel,
    });
  }
  return {
    channel,
    reads: describeMatcher(m),
    predicates: lowerEventPredicates(m, channel),
    eventOf: {
      participant: owner.name,
      event: m.event,
    },
  };
}

function lowerEventPredicates(
  m: Extract<
    VerifyMatcher,
    {
      kind: 'event';
    }
  >,
  channel: string,
): unknown[] {
  const bounds = boundsOf(m);
  const base = {
    kind: 'x-noetic-event',
    channel,
    event: m.event,
  };
  if (bounds.length === 0) {
    return [
      base,
    ];
  }
  return bounds.map((count) => ({
    ...base,
    count,
  }));
}

function lowerSensePredicates(
  m: Extract<
    VerifyMatcher,
    {
      kind: 'sense';
    }
  >,
): unknown[] {
  const selection = compileMatcher(m.sense, m.match);
  const bounds = boundsOf(m);
  if (m.tolerance !== undefined && m.equals === undefined) {
    throw verifyInvalid(
      `Matcher '${m.sense} ${m.match}' has a tolerance but no value to compare it with.`,
      'Give the value with .equals(value, { tolerance }).',
    );
  }
  const exact = selection.checksValue ? undefined : selection.exact;
  const match = {
    channel: m.sense,
    summary: exact,
  };
  if (exact !== undefined && m.equals === undefined && bounds.length === 0) {
    return [
      {
        kind: 'present',
        match,
      },
    ];
  }
  if (exact !== undefined && m.equals === undefined) {
    return bounds.map((b) => ({
      kind: 'count',
      match,
      op: b.op,
      value: b.value,
    }));
  }
  if (exact !== undefined && typeof m.equals === 'number' && bounds.length === 0) {
    return [
      {
        kind: 'measure',
        match,
        op: 'equals',
        value: m.equals,
        tolerance: m.tolerance ?? 0,
      },
    ];
  }
  const base = {
    kind: 'x-noetic-select',
    channel: m.sense,
    matcher: m.match,
    ...(m.equals === undefined
      ? {}
      : {
          equals: m.equals,
        }),
    ...(m.tolerance === undefined
      ? {}
      : {
          tolerance: m.tolerance,
        }),
  };
  if (bounds.length === 0) {
    return [
      base,
    ];
  }
  return bounds.map((count) => ({
    ...base,
    count,
  }));
}

function lowerMatcher(
  input: VerifyMatcher,
  participants: ReadonlyArray<VerifyParticipant>,
  subject: VerifyParticipant,
): Lowered {
  const m = toVerifyMatcher(input);
  if (m.kind === 'event') {
    return eventChannel(m, participants, subject);
  }
  return {
    channel: m.sense,
    reads: describeMatcher(m),
    predicates: lowerSensePredicates(m),
  };
}

function toClaim(lowered: Lowered, id: string): Claim {
  const assertions: Assertion[] = lowered.predicates.map((predicate, i) => ({
    id: lowered.predicates.length === 1 ? `${id}.assertion` : `${id}.assertion[${i}]`,
    predicate,
    reads: lowered.reads,
    channels: [
      lowered.channel,
    ],
  }));
  return {
    id,
    statement: `${lowered.reads} after the action`,
    declaredAt: 'before-action',
    assertions,
  };
}

function toConstraint(lowered: Lowered, id: string): Constraint {
  const [only] = lowered.predicates;
  const presentOnly =
    lowered.predicates.length === 1 &&
    typeof only === 'object' &&
    only !== null &&
    'kind' in only &&
    only.kind === 'present' &&
    'match' in only;
  const predicate = presentOnly
    ? {
        kind: 'absent',
        match: only.match,
      }
    : {
        kind: 'x-noetic-never',
        holds: lowered.predicates,
      };
  return {
    id,
    statement: `never ${lowered.reads} while the action runs`,
    predicate,
    channels: [
      lowered.channel,
    ],
    severity: 'blocking',
  };
}

function unsatisfied(connection: string, missing: ConnectionMissing): ConnectionUnsatisfiedError {
  return new ConnectionUnsatisfiedError({
    connection,
    missing,
    hint: 'Watch a sense the subject or a witness declares, or add a witness that perceives it.',
  });
}

function parseClaims(claims: ReadonlyArray<Claim>): Claim[] {
  return claims.map((claim, i) => {
    const parsed = OvpClaimSchema.safeParse(claim);
    if (!parsed.success) {
      throw verifyInvalid(
        `claims[${i}] is not an OVP claim: ${parsed.error.issues.map((x) => x.message).join('; ')}.`,
      );
    }
    return parsed.data;
  });
}

function parseConstraints(constraints: ReadonlyArray<Constraint>): Constraint[] {
  return constraints.map((constraint, i) => {
    const parsed = OvpConstraintSchema.safeParse(constraint);
    if (!parsed.success) {
      throw verifyInvalid(
        `constraints[${i}] is not an OVP constraint: ${parsed.error.issues.map((x) => x.message).join('; ')}.`,
      );
    }
    return parsed.data;
  });
}

function checkShape(spec: VerifySpec): void {
  const hasExpect = spec.expect !== undefined;
  const hasClaims = spec.claims !== undefined;
  if (hasExpect === hasClaims) {
    throw verifyInvalid(
      `Verify '${spec.id}' needs exactly one of expect (matchers) or claims (OVP claims).`,
    );
  }
  if (spec.never !== undefined && spec.constraints !== undefined) {
    throw verifyInvalid(
      `Verify '${spec.id}' takes never (matchers) or constraints (OVP constraints), not both.`,
    );
  }
  checkClose(spec);
}

function checkClose(spec: VerifySpec): void {
  const close = spec.close;
  if (!close) {
    return;
  }
  if (close.until === 'event' && !close.event) {
    throw verifyInvalid(
      `Verify '${spec.id}' closes on an event but names none.`,
      "Set close.event when close.until is 'event'.",
    );
  }
  for (const [name, value] of [
    [
      'quietMs',
      close.quietMs,
    ],
    [
      'timeoutMs',
      close.timeoutMs,
    ],
  ] as const) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      throw verifyInvalid(`Verify '${spec.id}' close.${name} must be a positive number.`);
    }
  }
}

/** Every sense a claim or constraint reads must be perceived by a participant. */
function checkPerceived(
  channels: ReadonlyArray<string>,
  participants: ReadonlyArray<VerifyParticipant>,
  subject: VerifyParticipant,
): void {
  for (const channel of channels) {
    if (participants.some((p) => p.senses[channel] !== undefined)) {
      continue;
    }
    if (!isSenseId(channel)) {
      throw verifyInvalid(
        `'${channel}' is not a sense: name one of spec 36's senses or an x- sense.`,
      );
    }
    throw unsatisfied(subject.name, {
      kind: 'sense',
      sense: channel,
    });
  }
}

function sensesByParticipant(
  channels: ReadonlyArray<string>,
  participants: ReadonlyArray<VerifyParticipant>,
): Record<string, SenseId[]> {
  const out: Record<string, SenseId[]> = {};
  for (const p of participants) {
    out[p.name] = [
      ...new Set(channels),
    ].filter((c): c is SenseId => isSenseId(c) && p.senses[c] !== undefined);
  }
  return out;
}

function addEvent(out: Record<string, string[]>, participant: string, event: string): void {
  const list = out[participant] ?? [];
  if (!list.includes(event)) {
    list.push(event);
  }
  out[participant] = list;
}

//#endregion

//#region Public API

/**
 * Validates a verify against its participants and lowers it to OVP.
 *
 * @throws NoeticConfigError `VERIFY_INVALID` when a matcher cannot be parsed or the verify is malformed.
 * @throws ConnectionUnsatisfiedError `CONNECTION_UNSATISFIED` when a matcher needs a sense or event no participant offers.
 */
export function prepareVerify(
  spec: VerifySpec,
  participants: ReadonlyArray<VerifyParticipant>,
): PreparedVerify {
  const subject = participants.find((p) => p.role === 'subject');
  if (!subject) {
    throw verifyInvalid(
      `Verify '${spec.id}' has no subject.`,
      'Name the connection being checked as subject.',
    );
  }
  checkShape(spec);
  const events: Record<string, string[]> = {};
  const lowerAll = (list: ReadonlyArray<VerifyMatcher>): Lowered[] =>
    list.map((m) => {
      const lowered = lowerMatcher(m, participants, subject);
      if (lowered.eventOf) {
        addEvent(events, lowered.eventOf.participant, lowered.eventOf.event);
      }
      return lowered;
    });
  const claims = spec.claims
    ? parseClaims(spec.claims)
    : lowerAll(spec.expect ?? []).map((l, i) => toClaim(l, `expect[${i}]`));
  const constraints = spec.constraints
    ? parseConstraints(spec.constraints)
    : lowerAll(spec.never ?? []).map((l, i) => toConstraint(l, `never[${i}]`));
  const channels = [
    ...claims.flatMap((c) => c.assertions.flatMap((a) => a.channels)),
    ...constraints.flatMap((c) => c.channels),
  ];
  checkPerceived(channels, participants, subject);
  const closeEvent = spec.close?.until === 'event' ? spec.close.event : undefined;
  if (closeEvent !== undefined) {
    if (subject.manifest.events[closeEvent] === undefined) {
      throw unsatisfied(subject.name, {
        kind: 'event',
        event: closeEvent,
      });
    }
    addEvent(events, subject.name, closeEvent);
  }
  return {
    spec,
    claims,
    constraints,
    senses: sensesByParticipant(channels, participants),
    events,
  };
}

//#endregion
