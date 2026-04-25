/**
 * Unit tests for the git plumbing — focused on the pure parsing helpers.
 * Mirrors the upstream pi-extension test cases for parseStatusPorcelainZ +
 * shouldNormalizeBranchChanges.
 */

import { describe, expect, test } from 'bun:test';

import { __testing } from '../../src/commands/builtins/diff-review/git.js';
import { ChangeStatus } from '../../src/commands/builtins/diff-review/types.js';

const {
  parseStatusPorcelainZ,
  shouldNormalizeBranchChanges,
  parseNameStatus,
  isIncludedReviewPath,
} = __testing;

describe('parseStatusPorcelainZ', () => {
  test('classifies untracked, modified, deleted and renamed entries', () => {
    const tokens = [
      'M  src/a.ts',
      'AD src/b.ts',
      ' D src/c.ts',
      'R  src/old.ts',
      'src/new.ts',
      '?? src/d.ts',
      '!! ignored.ts',
      '',
    ];
    const z = `${tokens.join('\0')}\0`;
    const info = parseStatusPorcelainZ(z);

    expect(info.hasChanges).toBe(true);
    expect(info.hasReviewableChanges).toBe(true);
    expect(info.hasUntracked).toBe(true);
    expect(info.untrackedPaths).toEqual([
      'src/d.ts',
    ]);
    expect(info.hasTrackedDeletions).toBe(true);
    expect(info.hasRenames).toBe(true);
  });

  test('ignored entries do not flip hasChanges by themselves', () => {
    const z = '!! ignored.ts\0';
    const info = parseStatusPorcelainZ(z);
    expect(info.hasChanges).toBe(false);
    expect(info.hasReviewableChanges).toBe(false);
  });

  test('skips minified js/css from reviewable set', () => {
    const z =
      [
        '?? src/build.min.js',
        '?? src/styles.min.css',
      ].join('\0') + '\0';
    const info = parseStatusPorcelainZ(z);
    expect(info.hasUntracked).toBe(false);
    expect(info.hasReviewableChanges).toBe(false);
  });
});

describe('shouldNormalizeBranchChanges', () => {
  test('returns true when there are working-tree renames', () => {
    expect(
      shouldNormalizeBranchChanges([], {
        hasChanges: true,
        hasReviewableChanges: true,
        hasUntracked: false,
        hasTrackedDeletions: false,
        hasRenames: true,
        untrackedPaths: [],
      }),
    ).toBe(true);
  });

  test('returns false when no untracked and no renames', () => {
    expect(
      shouldNormalizeBranchChanges([], {
        hasChanges: false,
        hasReviewableChanges: false,
        hasUntracked: false,
        hasTrackedDeletions: false,
        hasRenames: false,
        untrackedPaths: [],
      }),
    ).toBe(false);
  });

  test('returns true with untracked + tracked-deletion overlap', () => {
    expect(
      shouldNormalizeBranchChanges(
        [
          {
            status: ChangeStatus.Deleted,
            oldPath: 'a.ts',
            newPath: null,
          },
        ],
        {
          hasChanges: true,
          hasReviewableChanges: true,
          hasUntracked: true,
          hasTrackedDeletions: false,
          hasRenames: false,
          untrackedPaths: [
            'b.ts',
          ],
        },
      ),
    ).toBe(true);
  });

  test('returns false when only untracked changes (no deletions)', () => {
    expect(
      shouldNormalizeBranchChanges(
        [
          {
            status: ChangeStatus.Modified,
            oldPath: 'a.ts',
            newPath: 'a.ts',
          },
        ],
        {
          hasChanges: true,
          hasReviewableChanges: true,
          hasUntracked: true,
          hasTrackedDeletions: false,
          hasRenames: false,
          untrackedPaths: [
            'b.ts',
          ],
        },
      ),
    ).toBe(false);
  });
});

describe('parseNameStatus', () => {
  test('parses Added, Modified, Deleted, Renamed lines', () => {
    const out = [
      'M\tsrc/a.ts',
      'A\tsrc/b.ts',
      'D\tsrc/c.ts',
      'R100\tsrc/old.ts\tsrc/new.ts',
    ].join('\n');
    const changes = parseNameStatus(out);
    expect(changes).toEqual([
      {
        status: ChangeStatus.Modified,
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
      },
      {
        status: ChangeStatus.Added,
        oldPath: null,
        newPath: 'src/b.ts',
      },
      {
        status: ChangeStatus.Deleted,
        oldPath: 'src/c.ts',
        newPath: null,
      },
      {
        status: ChangeStatus.Renamed,
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
      },
    ]);
  });

  test('drops malformed lines instead of throwing', () => {
    const out = [
      '',
      'X',
      'M\tok.ts',
    ].join('\n');
    const changes = parseNameStatus(out);
    expect(changes).toEqual([
      {
        status: ChangeStatus.Modified,
        oldPath: 'ok.ts',
        newPath: 'ok.ts',
      },
    ]);
  });
});

describe('isIncludedReviewPath', () => {
  test('keeps regular source files', () => {
    expect(isIncludedReviewPath('src/a.ts')).toBe(true);
    expect(isIncludedReviewPath('README.md')).toBe(true);
  });

  test('skips minified bundles', () => {
    expect(isIncludedReviewPath('dist/app.min.js')).toBe(false);
    expect(isIncludedReviewPath('dist/app.min.css')).toBe(false);
  });

  test('rejects empty path', () => {
    expect(isIncludedReviewPath('')).toBe(false);
  });
});
