import { describe, expect, it } from 'bun:test';
import * as types from '../src/index';
import { ARTIFACT_URI_PREFIX, artifactDigest, artifactUri } from '../src/types/artifact-store';
import * as verify from '../src/verify';
import {
  OvpClaimSchema,
  OvpConstraintSchema,
  VERIFICATION_RUN_ITEM_TYPE,
  VerifyConfigErrorCode,
} from '../src/verify';

const HEX = 'd'.repeat(64);

describe('artifact URIs', () => {
  it('round-trips a digest', () => {
    const uri = artifactUri(HEX);
    expect(uri).toBe(`${ARTIFACT_URI_PREFIX}${HEX}`);
    expect(artifactDigest(uri)).toBe(HEX);
  });

  it('rejects other URIs and short digests', () => {
    expect(artifactDigest('https://example.com/x')).toBeUndefined();
    expect(artifactDigest(`${ARTIFACT_URI_PREFIX}abc`)).toBeUndefined();
  });
});

describe('@noetic-tools/types/verify', () => {
  it('exposes the verify constants', () => {
    expect(VERIFICATION_RUN_ITEM_TYPE).toBe('noetic:verification_run');
    expect(VerifyConfigErrorCode.Invalid).toBe('VERIFY_INVALID');
    expect(verify.OVP_VERSION).toBe('1.0');
    expect(verify.RunOutcome.PARTIAL).toBe('partial');
  });

  it('keeps OVP Verdict out of the main entry, which has its own', () => {
    expect('Verdict' in types).toBe(false);
    expect(verify.Verdict.NO_FAULT).toBe('no-fault');
  });

  it('applies OVP defaults when parsing claims and constraints', () => {
    const claim = OvpClaimSchema.parse({
      id: 'c',
      statement: 's',
      declaredAt: 'before-action',
    });
    expect(claim.assertions).toEqual([]);
    const constraint = OvpConstraintSchema.parse({
      id: 'k',
      statement: 's',
      channels: [
        'x-orders-db',
      ],
    });
    expect(constraint.severity).toBe('blocking');
    expect(
      OvpConstraintSchema.safeParse({
        id: 'k',
        statement: 's',
        channels: [
          'sound',
        ],
      }).success,
    ).toBe(false);
  });
});
