/**
 * `@noetic-tools/types/verify` mirrors open-verification's types field for
 * field without importing it (spec 37 § Under the hood). This test is where
 * the two are checked to agree: the types in both directions at compile time,
 * and the constants, defaults and zod mirrors at run time.
 */

import { describe, expect, it } from 'bun:test';
import { SenseDefaults } from '@noetic-tools/types';
import * as Mirror from '@noetic-tools/types/verify';
import * as Ovp from 'open-verification';

//#region Type-level agreement

type Mutual<A, B> = [
  A,
] extends [
  B,
]
  ? [
      B,
    ] extends [
      A,
    ]
    ? true
    : false
  : false;
type Agree<T extends true> = T;

export type TypeAgreement = [
  Agree<Mutual<Mirror.SubjectRef, Ovp.SubjectRef>>,
  Agree<Mutual<Mirror.Invalidation, Ovp.Invalidation>>,
  Agree<Mutual<Mirror.ChannelDescriptor, Ovp.ChannelDescriptor>>,
  Agree<Mutual<Mirror.DeterminismProfile, Ovp.DeterminismProfile>>,
  Agree<Mutual<Mirror.Intent, Ovp.Intent>>,
  Agree<Mutual<Mirror.Assertion, Ovp.Assertion>>,
  Agree<Mutual<Mirror.Claim, Ovp.Claim>>,
  Agree<Mutual<Mirror.Constraint, Ovp.Constraint>>,
  Agree<Mutual<Mirror.Match, Ovp.Match>>,
  Agree<Mutual<Mirror.Predicate, Ovp.Predicate>>,
  Agree<Mutual<Mirror.Capability, Ovp.Capability>>,
  Agree<Mutual<Mirror.Handle, Ovp.Handle>>,
  Agree<Mutual<Mirror.Action, Ovp.Action>>,
  Agree<Mutual<Mirror.ActionReceipt, Ovp.ActionReceipt>>,
  Agree<Mutual<Mirror.Window, Ovp.Window>>,
  Agree<Mutual<Mirror.Observation, Ovp.Observation>>,
  Agree<Mutual<Mirror.Provenance, Ovp.Provenance>>,
  Agree<Mutual<Mirror.Evidence, Ovp.Evidence>>,
  Agree<Mutual<Mirror.BlindSpot, Ovp.BlindSpot>>,
  Agree<Mutual<Mirror.Coverage, Ovp.Coverage>>,
  Agree<Mutual<Mirror.Anomaly, Ovp.Anomaly>>,
  Agree<Mutual<Mirror.VerdictRecord, Ovp.VerdictRecord>>,
  Agree<Mutual<Mirror.ConstraintViolation, Ovp.ConstraintViolation>>,
  Agree<Mutual<Mirror.Repair, Ovp.Repair>>,
  Agree<Mutual<Mirror.VerificationRun, Ovp.VerificationRun>>,
  Agree<Mutual<Mirror.Adjudication, Ovp.Adjudication>>,
  Agree<Mutual<Mirror.AdjudicationInput, Ovp.AdjudicationInput>>,
  Agree<Mutual<Mirror.ActorClaim, Ovp.ActorClaim>>,
  Agree<Mutual<Mirror.WitnessReport, Ovp.WitnessReport>>,
  Agree<Mutual<Mirror.Verdict, Ovp.Verdict>>,
  Agree<Mutual<Mirror.Ground, Ovp.Ground>>,
  Agree<Mutual<Mirror.RunOutcome, Ovp.RunOutcome>>,
  Agree<Mutual<Mirror.CloseCondition, Ovp.CloseCondition>>,
  Agree<Mutual<Mirror.BlindSpotKind, Ovp.BlindSpotKind>>,
  Agree<Mutual<Mirror.AnomalyKind, Ovp.AnomalyKind>>,
  Agree<Mutual<Mirror.ChannelId, Ovp.ChannelId>>,
  Agree<Mutual<Mirror.DeclaredChannelId, Ovp.DeclaredChannelId>>,
];

//#endregion

//#region Fixtures

const VALID_CLAIM = {
  id: 'c1',
  statement: 'the order exists',
  declaredAt: 'before-action',
  assertions: [
    {
      id: 'a1',
      reads: 'the create request',
      channels: [
        'net',
        'x-orders-db',
      ],
      predicate: {
        kind: 'present',
        match: {
          channel: 'net',
        },
      },
    },
  ],
};

const CLAIM_CASES: unknown[] = [
  VALID_CLAIM,
  {
    ...VALID_CLAIM,
    assertions: undefined,
  },
  {
    ...VALID_CLAIM,
    intent: 'i1',
  },
  {
    ...VALID_CLAIM,
    id: '',
  },
  {
    ...VALID_CLAIM,
    declaredAt: 'sometime',
  },
  {
    ...VALID_CLAIM,
    assertions: [
      {
        id: 'a',
        reads: 'r',
        channels: [],
      },
    ],
  },
  {
    ...VALID_CLAIM,
    assertions: [
      {
        id: 'a',
        reads: 'r',
        channels: [
          'X-Bad',
        ],
      },
    ],
  },
  {
    ...VALID_CLAIM,
    assertions: [
      {
        id: 'a',
        reads: 'r',
        channels: [
          'smell',
        ],
      },
    ],
  },
];

const VALID_CONSTRAINT = {
  id: 'k1',
  statement: 'no server errors',
  channels: [
    'net',
  ],
};

const CONSTRAINT_CASES: unknown[] = [
  VALID_CONSTRAINT,
  {
    ...VALID_CONSTRAINT,
    severity: 'advisory',
  },
  {
    ...VALID_CONSTRAINT,
    severity: 'fatal',
  },
  {
    ...VALID_CONSTRAINT,
    channels: [],
  },
  {
    ...VALID_CONSTRAINT,
    statement: '',
  },
];

//#endregion

describe('@noetic-tools/types/verify agrees with open-verification', () => {
  it('has the same protocol version', () => {
    expect(Mirror.OVP_VERSION).toBe(Ovp.OVP_VERSION);
  });

  it('has the same literal enums', () => {
    expect(Mirror.Surface).toEqual(Ovp.Surface);
    expect(Mirror.ChannelId).toEqual(Ovp.ChannelId);
    expect(Mirror.Independence).toEqual(Ovp.Independence);
    expect(Mirror.Grade).toEqual(Ovp.Grade);
    expect(Mirror.ResumeStrategy).toEqual(Ovp.ResumeStrategy);
    expect(Mirror.IntentOrigin).toEqual(Ovp.IntentOrigin);
    expect(Mirror.IntentStatus).toEqual(Ovp.IntentStatus);
    expect(Mirror.Declaration).toEqual(Ovp.Declaration);
    expect(Mirror.CountOp).toEqual(Ovp.CountOp);
    expect(Mirror.MeasureOp).toEqual(Ovp.MeasureOp);
    expect(Mirror.PredicateKind).toEqual(Ovp.PredicateKind);
    expect(Mirror.RefusalReason).toEqual(Ovp.RefusalReason);
    expect(Mirror.CloseCondition).toEqual(Ovp.CloseCondition);
    expect(Mirror.ProvenanceClass).toEqual(Ovp.ProvenanceClass);
    expect(Mirror.BlindSpotKind).toEqual(Ovp.BlindSpotKind);
    expect(Mirror.Verdict).toEqual(Ovp.Verdict);
    expect(Mirror.AnomalyKind).toEqual(Ovp.AnomalyKind);
    expect(Mirror.AnomalyTier).toEqual(Ovp.AnomalyTier);
    expect(Mirror.RunOutcome).toEqual(Ovp.RunOutcome);
    expect(Mirror.Ground).toEqual(Ovp.Ground);
  });

  it("Noetic's sense defaults are OVP's channel defaults", () => {
    expect(SenseDefaults).toEqual(Ovp.CHANNEL_DEFAULTS);
  });

  it('the claim mirror accepts and rejects what OVP does, with the same result', () => {
    for (const input of CLAIM_CASES) {
      const mirror = Mirror.OvpClaimSchema.safeParse(input);
      const ovp = Ovp.ClaimSchema.safeParse(input);
      expect(mirror.success).toBe(ovp.success);
      if (ovp.success) {
        expect(mirror.data).toEqual(ovp.data);
      }
    }
  });

  it('the constraint mirror accepts and rejects what OVP does, with the same defaults', () => {
    for (const input of CONSTRAINT_CASES) {
      const mirror = Mirror.OvpConstraintSchema.safeParse(input);
      const ovp = Ovp.ConstraintSchema.safeParse(input);
      expect(mirror.success).toBe(ovp.success);
      if (ovp.success) {
        expect(mirror.data).toEqual(ovp.data);
      }
    }
  });

  it('the channel id mirror agrees with OVP on named, x- and invalid channels', () => {
    for (const id of [
      'net',
      'visual',
      'x-orders-db',
      'x-',
      'X-a',
      'smell',
      '',
    ]) {
      expect(Mirror.OvpChannelIdSchema.safeParse(id).success).toBe(
        Ovp.ChannelIdSchema.safeParse(id).success,
      );
    }
  });
});
