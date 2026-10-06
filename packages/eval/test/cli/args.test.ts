import { describe, expect, test } from 'bun:test';

import { parseCliArgs, UsageError } from '../../src/cli/args';
import { OptimizeScope } from '../../src/types/eval';

describe('parseCliArgs', () => {
  test('defaults with empty argv', () => {
    const args = parseCliArgs([]);
    expect(args.files).toEqual([]);
    expect(args.verbose).toBe(false);
    expect(args.json).toBe(false);
    expect(args.watch).toBe(false);
    expect(args.optimize).toBe(false);
    expect(args.scope).toBe(OptimizeScope.PromptsOnly);
    expect(args.dryRun).toBe(false);
    expect(args.forceDirty).toBe(false);
    expect(args.concurrency).toBeUndefined();
    expect(args.saveBaseline).toBe(false);
    expect(args.check).toBe(false);
  });

  test('collects positionals as file patterns', () => {
    const args = parseCliArgs([
      'support-agent',
      'routing-agent.eval.ts',
    ]);
    expect(args.files).toEqual([
      'support-agent',
      'routing-agent.eval.ts',
    ]);
  });

  test('accepts every valid --scope value', () => {
    for (const scope of Object.values(OptimizeScope)) {
      const args = parseCliArgs([
        '--scope',
        scope,
      ]);
      expect(args.scope).toBe(scope);
    }
  });

  test('typo in --scope value throws UsageError (not swallowed as a file)', () => {
    let thrown: unknown;
    try {
      parseCliArgs([
        '--scope',
        'promts-only',
        'foo.eval.ts',
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
  });

  test('--scope at end of argv throws UsageError', () => {
    expect(() =>
      parseCliArgs([
        '--scope',
      ]),
    ).toThrow(UsageError);
  });

  test('unknown flag throws UsageError', () => {
    expect(() =>
      parseCliArgs([
        '--regression',
      ]),
    ).toThrow(UsageError);
    expect(() =>
      parseCliArgs([
        '-x',
      ]),
    ).toThrow(UsageError);
  });

  test('--budget is no longer a recognised flag (removed dead cost knob)', () => {
    // The flag was accepted but never read anywhere downstream — a cost
    // control that silently did nothing. Unknown flags throw.
    expect(() =>
      parseCliArgs([
        '--budget',
        '12.5',
      ]),
    ).toThrow(UsageError);
  });

  test('--concurrency reads the following argv entry', () => {
    const args = parseCliArgs([
      '--concurrency',
      '8',
      'a.eval.ts',
    ]);
    expect(args.concurrency).toBe(8);
    expect(args.files).toEqual([
      'a.eval.ts',
    ]);
  });

  test('--concurrency rejects a missing value', () => {
    expect(() =>
      parseCliArgs([
        '--concurrency',
      ]),
    ).toThrow(UsageError);
  });

  test('--concurrency rejects non-positive-integer values', () => {
    for (const bad of [
      '0',
      '-1',
      '2.5',
      'many',
    ]) {
      expect(() =>
        parseCliArgs([
          '--concurrency',
          bad,
        ]),
      ).toThrow(UsageError);
    }
  });

  test('boolean flags toggle', () => {
    const args = parseCliArgs([
      '--verbose',
      '--json',
      '--watch',
      '--dry-run',
      '--force-dirty',
      '--save-baseline',
      '--check',
    ]);
    expect(args.verbose).toBe(true);
    expect(args.json).toBe(true);
    expect(args.watch).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.forceDirty).toBe(true);
    expect(args.saveBaseline).toBe(true);
    expect(args.check).toBe(true);
  });
});
