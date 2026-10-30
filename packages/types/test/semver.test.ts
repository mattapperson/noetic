import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { compareSemVer, isValidRange, parseSemVer, satisfiesRange } from '../src/util/semver';

describe('parseSemVer', () => {
  it('parses full versions with prerelease and build', () => {
    expect(parseSemVer('1.2.3-rc.1+build')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'rc.1',
    });
  });

  it('rejects partial versions', () => {
    expect(parseSemVer('1.2')).toBeUndefined();
    expect(parseSemVer('one')).toBeUndefined();
  });
});

describe('compareSemVer', () => {
  it('orders a prerelease before its release', () => {
    const rc = parseSemVer('1.0.0-rc.1');
    const rel = parseSemVer('1.0.0');
    assert(rc);
    assert(rel);
    expect(compareSemVer(rc, rel)).toBeLessThan(0);
    expect(compareSemVer(rel, rc)).toBeGreaterThan(0);
    expect(compareSemVer(rel, rel)).toBe(0);
  });
});

describe('satisfiesRange', () => {
  const cases: Array<
    [
      string,
      string,
      boolean,
    ]
  > = [
    // caret boundaries: N-1, N, N+1 around the major
    [
      '1.1.9',
      '^1.2',
      false,
    ],
    [
      '1.2.0',
      '^1.2',
      true,
    ],
    [
      '1.9.9',
      '^1.2',
      true,
    ],
    [
      '2.0.0',
      '^1.2',
      false,
    ],
    [
      '2.0.0-rc.1',
      '^1.2',
      false,
    ],
    [
      '0.2.5',
      '^0.2',
      true,
    ],
    [
      '0.3.0',
      '^0.2',
      false,
    ],
    [
      '0.0.3',
      '^0.0.3',
      true,
    ],
    [
      '0.0.4',
      '^0.0.3',
      false,
    ],
    // tilde
    [
      '1.2.9',
      '~1.2.0',
      true,
    ],
    [
      '1.3.0',
      '~1.2.0',
      false,
    ],
    // partial and exact
    [
      '1.4.0',
      '1',
      true,
    ],
    [
      '2.0.0',
      '1',
      false,
    ],
    [
      '1.2.7',
      '1.2',
      true,
    ],
    [
      '1.2.3',
      '1.2.3',
      true,
    ],
    [
      '1.2.4',
      '1.2.3',
      false,
    ],
    [
      '5.0.0',
      '*',
      true,
    ],
    [
      '1.5.0',
      '1.x',
      true,
    ],
    // comparators, AND, OR
    [
      '1.5.0',
      '>=1.2.0 <2',
      true,
    ],
    [
      '2.0.0',
      '>=1.2.0 <2',
      false,
    ],
    [
      '1.0.0',
      '>1.0.0',
      false,
    ],
    [
      '1.0.0',
      '<=1.0.0',
      true,
    ],
    [
      '3.1.0',
      '^1 || ^3',
      true,
    ],
    [
      '2.1.0',
      '^1 || ^3',
      false,
    ],
    // garbage
    [
      'nope',
      '^1',
      false,
    ],
    [
      '1.0.0',
      'banana',
      false,
    ],
  ];

  for (const [version, range, expected] of cases) {
    it(`${version} ${expected ? 'satisfies' : 'does not satisfy'} ${range}`, () => {
      expect(satisfiesRange(version, range)).toBe(expected);
    });
  }
});

describe('isValidRange', () => {
  it('accepts ranges and rejects garbage', () => {
    expect(isValidRange('^1.2')).toBe(true);
    expect(isValidRange('>= 1.0.0 < 2')).toBe(true);
    expect(isValidRange('^1 || ~2.1')).toBe(true);
    expect(isValidRange('one')).toBe(false);
  });
});
