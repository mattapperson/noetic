import { describe, expect, test } from 'bun:test';
import {
  getToolCwd,
  retargetCwdForSpawn,
  setToolCwd,
  snapshotCwdState,
} from '../../src/runtime/cwd-helpers';
import { makeMockContext } from '../_helpers';

describe('cwd helpers', () => {
  test('getToolCwd returns the live cwd from cwdState', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/live',
      },
    });
    expect(getToolCwd(ctx)).toBe('/live');
  });

  test('getToolCwd prefers cwdState over fallback', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/live',
      },
    });
    expect(getToolCwd(ctx, '/fallback-not-used')).toBe('/live');
  });

  test('setToolCwd records previousCwd and updates cwd', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/before',
      },
    });
    const result = setToolCwd(ctx, '/after');
    expect(result.previousCwd).toBe('/before');
    expect(result.newCwd).toBe('/after');
    expect(ctx.cwdState.cwd).toBe('/after');
    expect(ctx.cwdState.previousCwd).toBe('/before');
  });

  test('setToolCwd mutation is observable via getToolCwd', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/start',
      },
    });
    setToolCwd(ctx, '/next');
    expect(getToolCwd(ctx)).toBe('/next');
  });

  test('two setToolCwd calls preserve the most recent previousCwd', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/one',
      },
    });
    setToolCwd(ctx, '/two');
    setToolCwd(ctx, '/three');
    expect(ctx.cwdState.cwd).toBe('/three');
    expect(ctx.cwdState.previousCwd).toBe('/two');
  });

  test('setToolCwd to current cwd preserves previousCwd (cd . does not stomp OLDPWD)', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/x',
        previousCwd: '/y',
      },
    });
    const result = setToolCwd(ctx, '/x');
    expect(result.previousCwd).toBe('/y');
    expect(result.newCwd).toBe('/x');
    expect(ctx.cwdState.cwd).toBe('/x');
    expect(ctx.cwdState.previousCwd).toBe('/y');
  });
});

describe('snapshotCwdState', () => {
  test('returns a new object with the parent cwd and previousCwd', () => {
    const parent = makeMockContext({
      cwdState: {
        cwd: '/p',
        previousCwd: '/q',
      },
    });
    const snap = snapshotCwdState(parent);
    expect(snap).toEqual({
      cwd: '/p',
      previousCwd: '/q',
    });
  });

  test('snapshot is independent of the parent reference', () => {
    const parent = makeMockContext({
      cwdState: {
        cwd: '/p',
      },
    });
    const snap = snapshotCwdState(parent);
    snap.cwd = '/mutated';
    expect(parent.cwdState.cwd).toBe('/p');
  });
});

describe('retargetCwdForSpawn', () => {
  test('mutates ctx.cwdState.cwd without touching previousCwd', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/parent',
        previousCwd: '/historic',
      },
    });
    const restore = retargetCwdForSpawn(ctx, '/worktree');
    expect(ctx.cwdState.cwd).toBe('/worktree');
    expect(ctx.cwdState.previousCwd).toBe('/historic');
    restore();
    expect(ctx.cwdState.cwd).toBe('/parent');
    expect(ctx.cwdState.previousCwd).toBe('/historic');
  });

  test('restore callback is idempotent across save/mutate/restore', () => {
    const ctx = makeMockContext({
      cwdState: {
        cwd: '/a',
      },
    });
    const restore = retargetCwdForSpawn(ctx, '/b');
    restore();
    expect(ctx.cwdState.cwd).toBe('/a');
  });
});
