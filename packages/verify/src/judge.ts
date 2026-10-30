/**
 * Judge (spec 37 § Judging): each claim gets its own OVP `AdjudicationInput`
 * — evidence, gaps and anomalies on its own senses only — and OVP's
 * `adjudicate()` decides it. A claim about the screen is never proved by an
 * unrelated request, and a problem on `log` never decides a claim about `ui`.
 */

import { frameworkCast } from '@noetic-tools/types';
import type {
  Anomaly,
  ChannelDescriptor,
  Claim,
  Coverage,
  Observation,
  Repair,
  VerdictRecord,
  VerifyClaimVerdict,
  Window,
} from '@noetic-tools/types/verify';
import type { ChannelId } from 'open-verification';
import { adjudicate, witnessDisagreement } from 'open-verification';
import type { Recorded } from './observations';
import { toEvidence } from './observations';
import {
  assertionsHeld,
  assertionsHeldUnder,
  evaluatePredicate,
  isEventPredicate,
} from './predicates';
import type { RunState } from './run-state';

//#region Types

/** One claim judged. */
export interface Judged {
  readonly record: VerdictRecord;
  readonly verdict: VerifyClaimVerdict;
  readonly repair?: Repair;
}

//#endregion

//#region Helpers

function channelsOf(claim: Claim): string[] {
  return [
    ...new Set(claim.assertions.flatMap((a) => a.channels)),
  ];
}

/**
 * OVP 1.1.0 types `ActorClaim.channel` and `WitnessReport.channel` as the nine
 * named channels, though `witnessDisagreement` reads them only as strings and a
 * witness's senses are `x-` senses by design (spec 37 § Witnesses). The cast
 * widens the declared type to what the function accepts at run time.
 */
function ovpChannel(channel: string): ChannelId {
  return frameworkCast<ChannelId>(channel);
}

/** OVP's `witnessDisagreement` for a claim whose assertions span the subject and a witness. */
function disagreements(
  state: RunState,
  claim: Claim,
  observations: readonly Observation[],
): Anomaly[] {
  const subject = state.subject;
  const channels = channelsOf(claim);
  const subjectChannels = channels.filter((c) => subject.senses.includes(c));
  const witnessChannels = channels.filter(
    (c) =>
      !subject.senses.includes(c) &&
      state.participants.some((p) => p.role === 'witness' && p.senses.includes(c)),
  );
  const [actorChannel] = subjectChannels;
  if (actorChannel === undefined || witnessChannels.length === 0) {
    return [];
  }
  const subjectSide = claim.assertions.filter((a) =>
    a.channels.some((c) => subjectChannels.includes(c)),
  );
  if (assertionsHeld(subjectSide, observations, state) !== true) {
    return [];
  }
  return witnessChannels.flatMap((wc) => {
    const witnessSide = claim.assertions.filter((a) => a.channels.includes(wc));
    const seen = observations.filter(
      (o) =>
        o.channel === wc &&
        witnessSide.some(
          (a) =>
            evaluatePredicate(
              a.predicate,
              [
                o,
              ],
              state,
            ) === true,
        ),
    );
    const anomaly = witnessDisagreement(
      {
        claim: claim.statement,
        channel: ovpChannel(actorChannel),
      },
      {
        channel: ovpChannel(wc),
        observed: seen,
        blind: state.blindSpots.filter((s) => s.channel === wc),
      },
    );
    return anomaly
      ? [
          anomaly,
        ]
      : [];
  });
}

function coverageFor(state: RunState, channels: ReadonlyArray<string>, window: Window): Coverage {
  return {
    window: window.id,
    observed: [
      ...state.observed,
    ].filter((c) => channels.includes(c)),
    blindSpots: state.blindSpots.filter((s) =>
      s.channel === undefined ? s.impeaching : channels.includes(s.channel),
    ),
  };
}

function repairFor(claim: Claim, verdictId: string, recorded: ReadonlyArray<Recorded>): Repair {
  const expected = claim.assertions.map((a) => a.reads).join('; ');
  const seen = recorded.slice(0, 5).map((r) => `${r.observation.channel} ${r.observation.summary}`);
  const actual = seen.length > 0 ? seen.join('; ') : `nothing on ${channelsOf(claim).join(', ')}`;
  return {
    verdict: verdictId,
    expected,
    actual,
    evidence: recorded.map((r) => r.observation.id),
    instruction: `Make the action produce ${expected}; the verify saw ${actual}.`,
  };
}

//#endregion

//#region Public API

/** Judges one claim against only the evidence, gaps and anomalies on its own senses. */
export function judgeClaim(opts: {
  state: RunState;
  claim: Claim;
  index: number;
  window: Window;
  heldBefore: boolean | undefined;
}): Judged {
  const { state, claim, index, window, heldBefore } = opts;
  const channels = channelsOf(claim);
  const descriptors = new Map<string, ChannelDescriptor>();
  for (const c of channels) {
    const d = state.descriptor(c);
    if (d) {
      descriptors.set(c, d);
    }
  }
  const recorded = state.recorded.filter((r) => channels.includes(r.observation.channel));
  const observations = recorded.map((r) => r.observation);
  const coverage = coverageFor(state, channels, window);
  const anomalies = [
    ...state.anomalies.filter(
      (a) => channels.includes(a.between[0]) && channels.includes(a.between[1]),
    ),
    ...disagreements(state, claim, observations),
  ];
  const evidence = toEvidence(recorded, descriptors);
  const held = assertionsHeldUnder({
    assertions: claim.assertions,
    observations,
    coverage,
    ctx: state,
  });
  const adjudication = adjudicate({
    claim,
    window,
    channels: [
      ...descriptors.values(),
    ],
    evidence,
    coverage,
    anomalies,
    assertionsHeld: held,
    consequenceHeldBefore: heldBefore,
  });
  const verdictId = `verdict[${index}]`;
  const record: VerdictRecord = {
    id: verdictId,
    claim: claim.id,
    window: window.id,
    verdict: adjudication.verdict,
    reasons: [
      ...adjudication.reasons,
    ],
    evidence: evidence.map((e) => e.observation.id),
    anomalies,
    at: state.now(),
    ...(adjudication.grade === undefined
      ? {}
      : {
          grade: adjudication.grade,
        }),
  };
  const failed = adjudication.verdict === 'no' && adjudication.ground === 'assertion-failed';
  return {
    record,
    verdict: {
      claim: claim.id,
      verdict: adjudication.verdict,
      ground: adjudication.ground,
      reasons: [
        ...adjudication.reasons,
      ],
    },
    ...(failed
      ? {
          repair: repairFor(claim, verdictId, recorded),
        }
      : {}),
  };
}

/**
 * Whether a claim already held before the action. `undefined` — nobody
 * checked — unless every sense the claim reads could be read beforehand.
 */
export function heldBefore(
  state: RunState,
  claim: Claim,
  readable: ReadonlySet<string>,
): boolean | undefined {
  const channels = channelsOf(claim);
  if (channels.length === 0 || !channels.every((c) => readable.has(c))) {
    return undefined;
  }
  // Reads carry no events: an event count before the action cannot be evaluated.
  if (claim.assertions.some((a) => isEventPredicate(a.predicate))) {
    return undefined;
  }
  const observations = state.before
    .filter((r) => channels.includes(r.observation.channel))
    .map((r) => r.observation);
  return assertionsHeld(claim.assertions, observations, state);
}

//#endregion
