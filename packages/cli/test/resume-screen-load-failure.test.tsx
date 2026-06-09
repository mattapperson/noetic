/**
 * Regression coverage for PR #35 bug #5 (`ResumeScreen`'s load-failure branch
 * was a dead-end) and #8 (hardcoded `red` instead of `theme.error`).
 *
 * The load-failure branch is now rendered by `LoadFailedView`, whose
 * `useInput` handler delegates to the pure `shouldCancelOnKey` predicate.
 * Since `ink-testing-library` isn't a dependency we test the pure predicate
 * directly, simulate the `useInput` callback's behaviour, and scan the
 * source for the specific regressions (`color="red"` and missing useInput
 * wiring).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Key } from 'ink';

import { shouldCancelOnKey } from '../src/tui/components/resume/resume-screen.js';

//#region Helpers

type KeyLike = Pick<Key, 'escape' | 'ctrl'>;

function makeKey(overrides: Partial<KeyLike> = {}): KeyLike {
  return {
    escape: false,
    ctrl: false,
    ...overrides,
  };
}

//#endregion

//#region shouldCancelOnKey

describe('shouldCancelOnKey', () => {
  it('returns true for Esc', () => {
    expect(
      shouldCancelOnKey(
        '',
        makeKey({
          escape: true,
        }),
      ),
    ).toBe(true);
  });

  it('returns true for Ctrl+C', () => {
    expect(
      shouldCancelOnKey(
        'c',
        makeKey({
          ctrl: true,
        }),
      ),
    ).toBe(true);
  });

  it('returns false for Ctrl without "c"', () => {
    expect(
      shouldCancelOnKey(
        'a',
        makeKey({
          ctrl: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldCancelOnKey(
        '',
        makeKey({
          ctrl: true,
        }),
      ),
    ).toBe(false);
  });

  it('returns false for plain keys', () => {
    expect(shouldCancelOnKey('a', makeKey())).toBe(false);
    expect(shouldCancelOnKey('', makeKey())).toBe(false);
    expect(shouldCancelOnKey('c', makeKey())).toBe(false);
  });
});

//#endregion

//#region Simulated useInput callback (#5)

describe('LoadFailedView cancel regression', () => {
  // Mirrors the body of `LoadFailedView`'s useInput callback without
  // mounting Ink — if this contract changes in the component, the
  // source-scan test below fails.
  function simulateKey(
    input: string,
    key: Pick<Key, 'escape' | 'ctrl'>,
    onCancel: () => void,
  ): void {
    if (shouldCancelOnKey(input, key)) {
      onCancel();
    }
  }

  it('Esc fires onCancel exactly once — the bug #5 regression', () => {
    let cancelled = 0;
    simulateKey(
      '',
      makeKey({
        escape: true,
      }),
      () => {
        cancelled += 1;
      },
    );
    expect(cancelled).toBe(1);
  });

  it('Ctrl+C fires onCancel exactly once', () => {
    let cancelled = 0;
    simulateKey(
      'c',
      makeKey({
        ctrl: true,
      }),
      () => {
        cancelled += 1;
      },
    );
    expect(cancelled).toBe(1);
  });

  it('typing a plain character does not fire onCancel', () => {
    let cancelled = 0;
    simulateKey('x', makeKey(), () => {
      cancelled += 1;
    });
    expect(cancelled).toBe(0);
  });
});

//#endregion

//#region Source-level regressions for #5 + #8

describe('resume-screen.tsx source regressions', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', 'src', 'tui', 'components', 'resume', 'resume-screen.tsx'),
    'utf8',
  );

  it('does not hardcode color="red" anywhere (#8)', () => {
    expect(source).not.toMatch(/color="red"/);
  });

  it('routes the load-failure error text through theme.error', () => {
    expect(source).toMatch(/color=\{theme\.error\}[\s\S]*Failed to load session/);
  });

  it('wires useInput through shouldCancelOnKey inside LoadFailedView (#5)', () => {
    expect(source).toMatch(/useInput\(\s*\(input,\s*key\)\s*=>/);
    expect(source).toMatch(/shouldCancelOnKey\(input,\s*key\)/);
  });
});

//#endregion
