import { describe, expect, it } from 'bun:test';

import { deterministicWorktreeTaskId } from '../../src/tasks/worktree-tasks';

describe('deterministicWorktreeTaskId', () => {
  it('matches the node:crypto SHA-256 base64url digest (backwards-compat pin)', async () => {
    // The pre-Web-Crypto implementation used
    //   createHash('sha256').update('/repo').update('\x00').update('/repo/.worktrees/feat').digest('base64url')
    // which yields "GZGwEL3Lo_..." as its first 10 chars. Users with tasks
    // already on disk depend on this exact mapping — changing it would
    // orphan every existing task directory on a project.
    const id = await deterministicWorktreeTaskId('/repo', '/repo/.worktrees/feat');
    expect(id).toBe('T-GZGwEL3Lo_');
  });

  it('is deterministic across calls', async () => {
    const a = await deterministicWorktreeTaskId('/repo', '/repo/.worktrees/feat');
    const b = await deterministicWorktreeTaskId('/repo', '/repo/.worktrees/feat');
    expect(a).toBe(b);
  });

  it('diverges on different inputs', async () => {
    const a = await deterministicWorktreeTaskId('/repo', '/repo/.worktrees/feat-a');
    const b = await deterministicWorktreeTaskId('/repo', '/repo/.worktrees/feat-b');
    expect(a).not.toBe(b);
  });
});
