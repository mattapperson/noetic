import { describe, expect, it } from 'bun:test';
import { createInMemorySubprocessAdapter } from '../src/adapters/in-memory-subprocess-adapter';
import { AgentHarness } from '../src/runtime/agent-harness';

describe('createInMemorySubprocessAdapter', () => {
  it('tracks subprocess handles and supports stop', async () => {
    const adapter = createInMemorySubprocessAdapter();
    const handle = await adapter.spawn({
      command: 'planner',
      cwd: '/repo',
      metadata: {
        role: 'planner',
      },
    });

    expect(handle.metadata?.runtime).toBe('in-memory');
    expect((await adapter.get(handle.id))?.status).toBe('completed');

    const stopped = await adapter.stop(handle.id, 'done');
    expect(stopped.kind).toBe('stopped');
    expect((await adapter.get(handle.id))?.status).toBe('stopped');
  });
});

describe('AgentHarness subprocess adapter', () => {
  it('defaults to the in-memory subprocess adapter', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const handle = await harness.subprocess.spawn({
      command: 'noop',
    });

    expect(handle.metadata?.runtime).toBe('in-memory');
  });
});
