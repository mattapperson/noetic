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
    expect(args.budget).toBeUndefined();
    expect(args.dryRun).toBe(false);
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

  test('-u and --budget round-trip', () => {
    const args = parseCliArgs([
      '-u',
      '--budget',
      '12.5',
    ]);
    expect(args.optimize).toBe(true);
    expect(args.budget).toBe(12.5);
  });

  test('--budget without a value throws UsageError', () => {
    expect(() =>
      parseCliArgs([
        '--budget',
      ]),
    ).toThrow(UsageError);
  });

  test('--budget with a non-numeric value throws UsageError', () => {
    expect(() =>
      parseCliArgs([
        '--budget',
        'cheap',
      ]),
    ).toThrow(UsageError);
  });

  test('boolean flags toggle', () => {
    const args = parseCliArgs([
      '--verbose',
      '--json',
      '--watch',
      '--dry-run',
      '--save-baseline',
      '--check',
    ]);
    expect(args.verbose).toBe(true);
    expect(args.json).toBe(true);
    expect(args.watch).toBe(true);
    expect(args.dryRun).toBe(true);
    expect(args.saveBaseline).toBe(true);
    expect(args.check).toBe(true);
  });
});
