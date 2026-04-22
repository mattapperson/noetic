import { describe, expect, it } from 'bun:test';

import { rename, resume, session, tag } from '../src/commands/builtins/index.js';
import type {
  Command,
  CommandContext,
  LocalCommandCall,
  SessionSnapshot,
} from '../src/commands/types.js';

/** Load the local-command call. Tests pass in local-only commands, so the
 *  JSX branch is unreachable — throw if anyone passes a local-jsx command. */
async function loadLocalCall(cmd: Command): Promise<LocalCommandCall> {
  if (cmd.type !== 'local') {
    throw new Error(`Expected local command, got ${cmd.type}`);
  }
  const mod = await cmd.load();
  return mod.call;
}

function baseSnapshot(partial: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: '11111111-2222-4333-8444-555555555555',
    cwd: '/tmp/demo',
    effectiveCwd: '/tmp/demo',
    model: 'anthropic/claude-sonnet-4',
    createdAt: '2026-05-01T12:00:00.000Z',
    firstPrompt: 'hello world',
    messageCount: 3,
    cumulativeUsage: {
      inputTokens: 100,
      outputTokens: 200,
      cachedTokens: 50,
    },
    cumulativeCost: 0.0123,
    persistenceEnabled: true,
    ...partial,
  };
}

interface FakeCtx {
  ctx: CommandContext;
  customTitleSetTo: Array<string | undefined>;
  tagSetTo: Array<string | undefined>;
  cleared: boolean;
  restarts: Array<Parameters<CommandContext['restartWithSession']>[0]>;
}

function makeCtx(partial: Partial<SessionSnapshot> = {}): FakeCtx {
  const customTitleSetTo: Array<string | undefined> = [];
  const tagSetTo: Array<string | undefined> = [];
  const restarts: Array<Parameters<CommandContext['restartWithSession']>[0]> = [];
  const state = {
    customTitleSetTo,
    tagSetTo,
    cleared: false,
    restarts,
  };
  const snapshot = baseSnapshot(partial);
  const ctx: CommandContext = {
    config: {
      model: snapshot.model,
      cwd: snapshot.cwd,
      apiKey: 'key',
      maxTurns: 50,
    },
    cwd: snapshot.cwd,
    entries: [],
    skills: [],
    activatedSkills: new Set(),
    commands: [],
    clearEntries: () => {},
    memoryLayers: [],
    agentMode: 'normal',
    setAgentMode: async () => {},
    setModel: async () => {},
    sessionSnapshot: snapshot,
    setCustomTitle: (name) => {
      state.customTitleSetTo.push(name);
    },
    setTag: (t) => {
      state.tagSetTo.push(t);
    },
    clearSession: () => {
      state.cleared = true;
    },
    restartWithSession: (target) => {
      state.restarts.push(target);
    },
  };
  return {
    ctx,
    ...state,
  };
}

describe('/session', () => {
  it('prints a multi-line metadata report', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(session);
    const result = await call('', fake.ctx);
    expect(result.type).toBe('text');
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('Session 11111111-');
    expect(result.value).toContain('anthropic/claude-sonnet-4');
    expect(result.value).toContain('in 100 · out 200 · cached 50');
    expect(result.value).toContain('$0.0123');
    expect(result.value).toContain('persistence:   on');
  });

  it('reports persistence off when disabled', async () => {
    const fake = makeCtx({
      persistenceEnabled: false,
    });
    const call = await loadLocalCall(session);
    const result = await call('', fake.ctx);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('persistence:   off');
  });
});

describe('/rename', () => {
  it('sets the custom title when given a name', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(rename);
    const result = await call('bug triage', fake.ctx);
    expect(fake.customTitleSetTo).toEqual([
      'bug triage',
    ]);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('bug triage');
  });

  it('clears the title when given no argument', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(rename);
    const result = await call('   ', fake.ctx);
    expect(fake.customTitleSetTo).toEqual([
      undefined,
    ]);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('cleared');
  });
});

describe('/tag', () => {
  it('sets the tag (stripping a leading #)', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(tag);
    const result = await call('#bugs', fake.ctx);
    expect(fake.tagSetTo).toEqual([
      'bugs',
    ]);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('#bugs');
  });

  it('removes the current tag when given no argument', async () => {
    const fake = makeCtx({
      tag: 'existing',
    });
    const call = await loadLocalCall(tag);
    const result = await call('', fake.ctx);
    expect(fake.tagSetTo).toEqual([
      undefined,
    ]);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('Removed tag');
  });

  it('reports no-op when no tag and no argument', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(tag);
    const result = await call('', fake.ctx);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('No tag');
  });
});

describe('/resume', () => {
  it('requests the picker with no argument', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(resume);
    await call('', fake.ctx);
    expect(fake.restarts).toHaveLength(1);
    expect(fake.restarts[0].kind).toBe('picker');
  });

  it('rejects a non-UUID argument', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(resume);
    const result = await call('not-a-uuid', fake.ctx);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('not a valid session id');
    expect(fake.restarts).toHaveLength(0);
  });

  it('reports not found for an unknown UUID', async () => {
    const fake = makeCtx();
    const call = await loadLocalCall(resume);
    const result = await call('ffffffff-0000-4000-8000-000000000000', fake.ctx);
    if (result.type !== 'text') {
      throw new Error('expected text');
    }
    expect(result.value).toContain('not found');
  });
});
