import { describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { isNoeticError } from '../../src/errors/noetic-error';
import { ChannelStore } from '../../src/runtime/channel-store';

describe('ChannelStore', () => {
  describe('value mode', () => {
    it('last-write-wins', () => {
      const store = new ChannelStore();
      const ch = channel('test', {
        schema: z.number(),
        mode: 'value',
      });
      store.send(ch, 1);
      store.send(ch, 2);
      expect(store.tryRecv(ch)).toBe(2);
    });

    it('send wakes recv', async () => {
      const store = new ChannelStore();
      const ch = channel('test', {
        schema: z.string(),
        mode: 'value',
      });
      const promise = store.recv(ch, 5_000);
      store.send(ch, 'hello');
      expect(await promise).toBe('hello');
    });

    it('tryRecv returns null when no value set', () => {
      const store = new ChannelStore();
      const ch = channel('test', {
        schema: z.string(),
        mode: 'value',
      });
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('tryRecv returns current value without consuming it', () => {
      const store = new ChannelStore();
      const ch = channel('test', {
        schema: z.number(),
        mode: 'value',
      });
      store.send(ch, 42);
      expect(store.tryRecv(ch)).toBe(42);
      expect(store.tryRecv(ch)).toBe(42);
    });
  });

  describe('queue mode', () => {
    it('FIFO ordering', () => {
      const store = new ChannelStore();
      const ch = channel('q', {
        schema: z.number(),
        mode: 'queue',
      });
      store.send(ch, 1);
      store.send(ch, 2);
      store.send(ch, 3);
      expect(store.tryRecv(ch)).toBe(1);
      expect(store.tryRecv(ch)).toBe(2);
      expect(store.tryRecv(ch)).toBe(3);
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('send wakes recv', async () => {
      const store = new ChannelStore();
      const ch = channel('q', {
        schema: z.string(),
        mode: 'queue',
      });
      const promise = store.recv(ch, 5_000);
      store.send(ch, 'msg');
      expect(await promise).toBe('msg');
    });

    it('tryRecv returns null when empty', () => {
      const store = new ChannelStore();
      const ch = channel('q', {
        schema: z.string(),
        mode: 'queue',
      });
      expect(store.tryRecv(ch)).toBeNull();
    });
  });

  describe('topic mode', () => {
    it('all receivers get every message', async () => {
      const store = new ChannelStore();
      const ch = channel('topic', {
        schema: z.string(),
        mode: 'topic',
      });
      const p1 = store.recv(ch, 5_000);
      const p2 = store.recv(ch, 5_000);
      store.send(ch, 'broadcast');
      expect(await p1).toBe('broadcast');
      expect(await p2).toBe('broadcast');
    });

    it('tryRecv always returns null', () => {
      const store = new ChannelStore();
      const ch = channel('topic', {
        schema: z.string(),
        mode: 'topic',
      });
      store.send(ch, 'hello');
      expect(store.tryRecv(ch)).toBeNull();
    });
  });

  describe('value mode recv edge cases', () => {
    it('recv returns immediately when value already exists', async () => {
      const store = new ChannelStore();
      const ch = channel('v-immediate', {
        schema: z.number(),
        mode: 'value',
      });
      store.send(ch, 42);
      const result = await store.recv(ch, 500);
      expect(result).toBe(42);
    });
  });

  describe('queue mode recv edge cases', () => {
    it('timeout <= 0 on recv hangs (does not resolve)', async () => {
      const store = new ChannelStore();
      const ch = channel('hang', {
        schema: z.string(),
        mode: 'queue',
      });
      // Race recv(timeout=0) against a short timer to prove it hangs
      const result = await Promise.race([
        store.recv(ch, 0).then(() => 'resolved'),
        new Promise<string>((r) => setTimeout(() => r('timed-out'), 10)),
      ]);
      expect(result).toBe('timed-out');
    });

    it('multiple concurrent recv waiters: only first wakes per send', async () => {
      const store = new ChannelStore();
      const ch = channel('multi-recv', {
        schema: z.number(),
        mode: 'queue',
      });
      const p1 = store.recv(ch, 500);
      const p2 = store.recv(ch, 500);
      store.send(ch, 1);
      store.send(ch, 2);
      expect(await p1).toBe(1);
      expect(await p2).toBe(2);
    });
  });

  describe('topic mode edge cases', () => {
    it('non-positive timeout warns and clamps to MAX', async () => {
      const warnSpy = spyOn(console, 'warn');
      const store = new ChannelStore();
      const ch = channel('topic-neg', {
        schema: z.string(),
        mode: 'topic',
      });
      // We can't wait for MAX_TOPIC_TIMEOUT, so just verify the warning fires
      // and that a send still resolves the recv
      const p = store.recv(ch, -1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('non-positive timeout');
      store.send(ch, 'ok');
      expect(await p).toBe('ok');
      warnSpy.mockRestore();
    });
  });

  describe('timeout', () => {
    it('recv throws channel_timeout', async () => {
      const store = new ChannelStore();
      const ch = channel('t', {
        schema: z.string(),
        mode: 'queue',
      });
      try {
        await store.recv(ch, 50);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('channel_timeout');
      }
    });

    it('value mode recv throws channel_timeout when no value', async () => {
      const store = new ChannelStore();
      const ch = channel('v', {
        schema: z.string(),
        mode: 'value',
      });
      try {
        await store.recv(ch, 50);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('channel_timeout');
      }
    });

    it('topic mode recv throws channel_timeout when no message', async () => {
      const store = new ChannelStore();
      const ch = channel('tp', {
        schema: z.string(),
        mode: 'topic',
      });
      try {
        await store.recv(ch, 50);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('channel_timeout');
      }
    });
  });

  describe('external channels', () => {
    it('getHandle returns typed handle', () => {
      const store = new ChannelStore();
      const ch = channel('ext', {
        schema: z.string(),
        mode: 'queue',
        external: true,
      });
      const handle = store.getHandle(ch, 'exec-1');
      expect(handle.closed).toBe(false);
      expect(handle.channel).toBe(ch);
    });

    it('handle.send delivers to channel', () => {
      const store = new ChannelStore();
      const ch = channel('ext', {
        schema: z.string(),
        mode: 'queue',
        external: true,
      });
      const handle = store.getHandle(ch, 'exec-1');
      handle.send('hello');
      expect(store.tryRecv(ch)).toBe('hello');
    });

    it('handle.closed reflects execution completion', () => {
      const store = new ChannelStore();
      const ch = channel('ext', {
        schema: z.string(),
        mode: 'queue',
        external: true,
      });
      const handle = store.getHandle(ch, 'exec-1');
      expect(handle.closed).toBe(false);
      store.closeExecution('exec-1');
      expect(handle.closed).toBe(true);
    });

    it('post-completion send throws channel_closed', () => {
      const store = new ChannelStore();
      const ch = channel('ext', {
        schema: z.string(),
        mode: 'queue',
        external: true,
      });
      const handle = store.getHandle(ch, 'exec-1');
      store.closeExecution('exec-1');
      try {
        handle.send('hello');
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('channel_closed');
      }
    });
  });

  // Back-pressure policy:
  // - External channels: drop oldest (to keep receiving new data from outside)
  // - Internal channels: drop newest (to preserve data already in the queue)
  describe('back-pressure', () => {
    it('drops oldest on full external channel queue', () => {
      const store = new ChannelStore();
      const ch = channel('ext-q', {
        schema: z.number(),
        mode: 'queue',
        capacity: 3,
        external: true,
      });
      store.send(ch, 1);
      store.send(ch, 2);
      store.send(ch, 3);
      // At capacity, send to external channel should drop oldest
      store.send(ch, 4);
      expect(store.tryRecv(ch)).toBe(2);
      expect(store.tryRecv(ch)).toBe(3);
      expect(store.tryRecv(ch)).toBe(4);
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('warns on overflow when dropping messages', () => {
      const warnSpy = spyOn(console, 'warn');
      const store = new ChannelStore();
      const ch = channel('overflow-test', {
        schema: z.number(),
        mode: 'queue',
        capacity: 2,
      });
      store.send(ch, 1);
      store.send(ch, 2);
      store.send(ch, 3); // should trigger warning
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('overflow-test');
      expect(warnSpy.mock.calls[0][0]).toContain('capacity');
      warnSpy.mockRestore();
    });

    it('drops on full internal channel queue', () => {
      const store = new ChannelStore();
      const ch = channel('int-q', {
        schema: z.number(),
        mode: 'queue',
        capacity: 2,
      });
      store.send(ch, 1);
      store.send(ch, 2);
      store.send(ch, 3); // At capacity, should be dropped for internal
      expect(store.tryRecv(ch)).toBe(1);
      expect(store.tryRecv(ch)).toBe(2);
      expect(store.tryRecv(ch)).toBeNull();
    });
  });

  describe('subscribeWake (non-consuming)', () => {
    it('fires every wake subscriber on next send and leaves the queue intact', () => {
      const store = new ChannelStore();
      const ch = channel<number>('wake-test', {
        schema: z.number(),
        mode: 'queue',
      });
      let fired = 0;
      store.subscribeWake(ch, () => {
        fired += 1;
      });
      store.send(ch, 99);
      expect(fired).toBe(1);
      // The send should still have populated the queue — wake is non-consuming.
      expect(store.tryRecv(ch)).toBe(99);
    });

    it('is one-shot — a second send after a fired wake does not re-fire', () => {
      const store = new ChannelStore();
      const ch = channel<number>('wake-once', {
        schema: z.number(),
        mode: 'queue',
      });
      let fired = 0;
      store.subscribeWake(ch, () => {
        fired += 1;
      });
      store.send(ch, 1);
      store.send(ch, 2);
      expect(fired).toBe(1);
    });

    it('unsubscribe before send removes the subscriber', () => {
      const store = new ChannelStore();
      const ch = channel<number>('wake-unsub', {
        schema: z.number(),
        mode: 'queue',
      });
      let fired = 0;
      const unsub = store.subscribeWake(ch, () => {
        fired += 1;
      });
      unsub();
      store.send(ch, 1);
      expect(fired).toBe(0);
    });

    it('works for value-mode channels — does not consume the latest value', () => {
      const store = new ChannelStore();
      const ch = channel<number>('wake-value', {
        schema: z.number(),
        mode: 'value',
      });
      let fired = 0;
      store.subscribeWake(ch, () => {
        fired += 1;
      });
      store.send(ch, 42);
      expect(fired).toBe(1);
      expect(store.tryRecv(ch)).toBe(42);
    });
  });
});
