import { describe, expect, it } from 'bun:test';
import { createInMemorySubprocessAdapter } from '../src/adapters/in-memory-subprocess-adapter';
import { AgentHarness } from '../src/harness/agent-harness';

describe('createInMemorySubprocessAdapter', () => {
  it('settles a finished handle and then forgets it', async () => {
    const adapter = createInMemorySubprocessAdapter();
    const { handle, settled } = await adapter.spawn({
      command: 'planner',
      cwd: '/repo',
      metadata: {
        role: 'planner',
      },
    });

    expect(handle.metadata?.runtime).toBe('in-memory');
    expect((await settled).status).toBe('completed');
    expect(await adapter.get(handle.id)).toBeNull();
    expect((await adapter.stop(handle.id, 'done')).kind).toBe('not_found');
  });

  it('stop() settles a running handle as stopped', async () => {
    const adapter = createInMemorySubprocessAdapter({
      run: () => new Promise<void>(() => {}),
    });
    const { handle, settled } = await adapter.spawn({
      command: 'planner',
    });
    expect((await adapter.get(handle.id))?.status).toBe('running');

    const stopped = await adapter.stop(handle.id, 'done');
    expect(stopped.kind).toBe('stopped');
    const final = await settled;
    expect(final.status).toBe('stopped');
    expect(final.metadata?.stopReason).toBe('done');
    expect(await adapter.get(handle.id)).toBeNull();
    expect(await adapter.isAlive(handle)).toBe(false);
  });

  it('metadataInjector stamps synchronous fields on the returned handle', async () => {
    const adapter = createInMemorySubprocessAdapter({
      metadataInjector: (request) =>
        request.kind === 'step'
          ? {
              stepInjected: true,
            }
          : {
              pid: 4242,
              pidStarttime: 'Mon Jan  1 00:00:00 2026',
            },
      run: async () => {
        // Never resolves — keeps the handle running so post-spawn assertions
        // observe pid without racing auto-completion.
        await new Promise<void>(() => {});
      },
    });

    const { handle } = await adapter.spawn({
      kind: 'process',
      command: 'bun',
      metadata: {
        taskRole: 'planner',
      },
    });

    expect(handle.metadata?.pid).toBe(4242);
    expect(handle.metadata?.pidStarttime).toBe('Mon Jan  1 00:00:00 2026');
    expect(handle.metadata?.taskRole).toBe('planner');
    expect(handle.status).toBe('running');
  });
});

describe('AgentHarness subprocess adapter', () => {
  it('defaults to the in-memory subprocess adapter', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const { handle } = await harness.subprocess.spawn({
      command: 'noop',
    });

    expect(handle.metadata?.runtime).toBe('in-memory');
  });
});
