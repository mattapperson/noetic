import { describe, expect, it } from 'bun:test';
import type { SubprocessHandle } from '@noetic-tools/types';
import { createLiveHandles } from '../../src/adapters/live-handles';

function running(id: string): SubprocessHandle {
  return {
    id,
    status: 'running',
    startedAt: 'now',
  };
}

describe('createLiveHandles', () => {
  it('holds an added handle until it settles', () => {
    const live = createLiveHandles();
    const { handle } = live.add(running('a'));
    expect(handle.id).toBe('a');
    expect(live.get('a')).toBe(handle);
    expect([
      ...live.values(),
    ]).toEqual([
      handle,
    ]);
  });

  it('settle resolves the promise with the final handle and forgets it', async () => {
    const live = createLiveHandles();
    const { settled } = live.add(running('a'));
    const final: SubprocessHandle = {
      ...running('a'),
      status: 'completed',
      metadata: {
        result: 42,
      },
    };
    expect(live.settle(final)).toBe(true);
    expect(await settled).toEqual(final);
    expect(live.get('a')).toBeUndefined();
    expect([
      ...live.values(),
    ]).toEqual([]);
  });

  it('settle on an already settled or unknown handle changes nothing', async () => {
    const live = createLiveHandles();
    const { settled } = live.add(running('a'));
    live.settle({
      ...running('a'),
      status: 'stopped',
    });
    expect(
      live.settle({
        ...running('a'),
        status: 'completed',
      }),
    ).toBe(false);
    expect((await settled).status).toBe('stopped');
    expect(live.settle(running('unknown'))).toBe(false);
  });

  it('update replaces a running handle and ignores a settled one', () => {
    const live = createLiveHandles();
    live.add(running('a'));
    live.update({
      ...running('a'),
      status: 'paused',
    });
    expect(live.get('a')?.status).toBe('paused');
    live.settle({
      ...running('a'),
      status: 'completed',
    });
    live.update(running('a'));
    expect(live.get('a')).toBeUndefined();
  });
});
