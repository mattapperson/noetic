/**
 * A `process` handle settles when its OS process exits: exit code 0
 * completes it, anything else fails it, and either way the adapter
 * forgets it.
 */

import { describe, expect, it } from 'bun:test';
import { createLocalSubprocessAdapter } from '../src/local-subprocess-adapter';

describe('local adapter process exit', () => {
  it('settles as completed on exit code 0 and forgets the handle', async () => {
    const adapter = createLocalSubprocessAdapter();
    const { handle, settled } = await adapter.spawn({
      kind: 'process',
      command: 'bun',
      args: [
        '-e',
        'setTimeout(() => process.exit(0), 50)',
      ],
    });
    expect(handle.status).toBe('running');
    const final = await settled;
    expect(final.status).toBe('completed');
    expect(final.metadata?.exitCode).toBe(0);
    expect(await adapter.get(handle.id)).toBeNull();
    expect(await adapter.listLive()).toHaveLength(0);
  });

  it('settles as failed on a non-zero exit code', async () => {
    const adapter = createLocalSubprocessAdapter();
    const { settled } = await adapter.spawn({
      kind: 'process',
      command: 'bun',
      args: [
        '-e',
        'setTimeout(() => process.exit(3), 50)',
      ],
    });
    const final = await settled;
    expect(final.status).toBe('failed');
    expect(final.metadata?.exitCode).toBe(3);
    expect(final.metadata?.error?.message).toContain('code 3');
  });

  it('stop() settles a running process as stopped', async () => {
    const adapter = createLocalSubprocessAdapter();
    const { handle, settled } = await adapter.spawn({
      kind: 'process',
      command: 'bun',
      args: [
        '-e',
        'setInterval(() => {}, 1e3)',
      ],
    });
    const stopped = await adapter.stop(handle.id, 'test over');
    expect(stopped.kind).toBe('stopped');
    expect((await settled).status).toBe('stopped');
    expect(await adapter.get(handle.id)).toBeNull();
  });
});
