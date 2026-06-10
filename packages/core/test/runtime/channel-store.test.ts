import { describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
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
    it('drains ALL parked waiters on send — none starve (C8)', async () => {
      const store = new ChannelStore();
      const ch = channel('v-multi-waiters', {
        schema: z.number(),
        mode: 'value',
      });
      const w1 = store.recv(ch, 200);
      const w2 = store.recv(ch, 200);
      store.send(ch, 42);
      expect(await w1).toBe(42);
      expect(await w2).toBe(42);
      // Non-consuming: the value is still readable.
      expect(store.tryRecv(ch)).toBe(42);
    });

    it('no stale-timer rejection fires after the drain', async () => {
      const store = new ChannelStore();
      const ch = channel('v-stale-timer', {
        schema: z.number(),
        mode: 'value',
      });
      const w1 = store.recv(ch, 30);
      const w2 = store.recv(ch, 30);
      store.send(ch, 7);
      expect(await w1).toBe(7);
      expect(await w2).toBe(7);
      // Wait past the original timeout window — the (cleared) timers must
      // not reject anything or throw.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

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

  // Back-pressure policy (spec 06):
  // - Internal senders (`send`): at capacity the send PARKS until a consumer
  //   dequeues an item; 30s default timeout -> channel_timeout; abort -> cancelled.
  // - External senders (`ChannelHandle.send`): sync drop-oldest, never block.
  describe('back-pressure', () => {
    it('sends below capacity resolve immediately (N-1, N)', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-immediate', {
        schema: z.number(),
        mode: 'queue',
        capacity: 2,
      });
      await store.send(ch, 1);
      await store.send(ch, 2);
      expect(store.tryRecv(ch)).toBe(1);
      expect(store.tryRecv(ch)).toBe(2);
    });

    it('send at capacity parks until a recv frees a slot; queue order preserved (N+1)', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-park', {
        schema: z.number(),
        mode: 'queue',
        capacity: 2,
      });
      await store.send(ch, 1);
      await store.send(ch, 2);

      let thirdResolved = false;
      const third = store.send(ch, 3).then(() => {
        thirdResolved = true;
      });
      // Parked — not resolved on the microtask queue.
      await Promise.resolve();
      expect(thirdResolved).toBe(false);

      // A recv dequeues the head, freeing a slot: the parked send resolves
      // and its value lands at the queue tail.
      expect(await store.recv(ch, 100)).toBe(1);
      await third;
      expect(thirdResolved).toBe(true);
      expect(store.tryRecv(ch)).toBe(2);
      expect(store.tryRecv(ch)).toBe(3);
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('tryRecv also promotes a parked sender', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-tryrecv', {
        schema: z.number(),
        mode: 'queue',
        capacity: 1,
      });
      await store.send(ch, 1);
      const parked = store.send(ch, 2);
      expect(store.tryRecv(ch)).toBe(1);
      await parked;
      expect(store.tryRecv(ch)).toBe(2);
    });

    it('parked send rejects channel_timeout when no consumer arrives', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-timeout', {
        schema: z.number(),
        mode: 'queue',
        capacity: 1,
      });
      await store.send(ch, 1);
      try {
        await store.send(ch, 2, {
          timeout: 20,
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'channel_timeout');
        expect(oe.channelName).toBe('bp-timeout');
        expect(oe.timeout).toBe(20);
      }
      // The timed-out value never entered the queue.
      expect(store.tryRecv(ch)).toBe(1);
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('abort rejects a parked sender with cancelled', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-abort', {
        schema: z.number(),
        mode: 'queue',
        capacity: 1,
      });
      await store.send(ch, 1);
      const controller = new AbortController();
      const parked = store.send(ch, 2, {
        signal: controller.signal,
      });
      controller.abort('producer cancelled');
      try {
        await parked;
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'cancelled');
        expect(oe.reason).toBe('producer cancelled');
      }
      expect(store.tryRecv(ch)).toBe(1);
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('multiple parked senders resolve FIFO as slots free', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-fifo', {
        schema: z.number(),
        mode: 'queue',
        capacity: 1,
      });
      await store.send(ch, 1);
      const order: number[] = [];
      const parked2 = store.send(ch, 2).then(() => {
        order.push(2);
      });
      const parked3 = store.send(ch, 3).then(() => {
        order.push(3);
      });

      expect(await store.recv(ch, 100)).toBe(1);
      await parked2;
      expect(order).toEqual([
        2,
      ]);
      expect(await store.recv(ch, 100)).toBe(2);
      await parked3;
      expect(order).toEqual([
        2,
        3,
      ]);
      expect(await store.recv(ch, 100)).toBe(3);
    });

    it('external handle still drops oldest at capacity (sync, with warning)', async () => {
      const warnSpy = spyOn(console, 'warn');
      const store = new ChannelStore();
      const ch = channel('ext-q', {
        schema: z.number(),
        mode: 'queue',
        capacity: 3,
        external: true,
      });
      const handle = store.getHandle(ch, 'exec-bp');
      handle.send(1);
      handle.send(2);
      handle.send(3);
      // At capacity, external send drops the OLDEST item.
      handle.send(4);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('ext-q');
      expect(warnSpy.mock.calls[0][0]).toContain('dropping oldest');
      warnSpy.mockRestore();
      expect(store.tryRecv(ch)).toBe(2);
      expect(store.tryRecv(ch)).toBe(3);
      expect(store.tryRecv(ch)).toBe(4);
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('value-mode send never parks (no capacity concept)', async () => {
      const store = new ChannelStore();
      const ch = channel('bp-value', {
        schema: z.number(),
        mode: 'value',
      });
      await store.send(ch, 1);
      await store.send(ch, 2);
      await store.send(ch, 3);
      expect(store.tryRecv(ch)).toBe(3);
    });
  });

  describe('abort integration (recv)', () => {
    it('rejects a parked recv with kind cancelled even with timeout 0', async () => {
      const store = new ChannelStore();
      const ch = channel('abort-q', {
        schema: z.string(),
        mode: 'queue',
      });
      const controller = new AbortController();
      const pending = store.recv(ch, 0, controller.signal);
      controller.abort('shutting down');
      try {
        await pending;
        expect.unreachable('should have rejected');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'cancelled');
        expect(oe.reason).toBe('shutting down');
      }
    });

    it('rejects immediately when the signal is already aborted', async () => {
      const store = new ChannelStore();
      const ch = channel('abort-pre', {
        schema: z.string(),
        mode: 'queue',
      });
      const controller = new AbortController();
      controller.abort('already gone');
      try {
        await store.recv(ch, 5_000, controller.signal);
        expect.unreachable('should have rejected');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('cancelled');
      }
    });

    it('abort that fires before the timer rejects with cancelled, not channel_timeout', async () => {
      const store = new ChannelStore();
      const ch = channel('abort-vs-timer', {
        schema: z.string(),
        mode: 'queue',
      });
      const controller = new AbortController();
      const pending = store.recv(ch, 50, controller.signal);
      controller.abort('abort first');
      try {
        await pending;
        expect.unreachable('should have rejected');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('cancelled');
      }
      // Give the (cleared) timer a chance to misfire — nothing should throw.
      await new Promise((resolve) => setTimeout(resolve, 70));
    });

    it('timeout that fires without abort still rejects channel_timeout', async () => {
      const store = new ChannelStore();
      const ch = channel('timer-vs-abort', {
        schema: z.string(),
        mode: 'queue',
      });
      const controller = new AbortController();
      try {
        await store.recv(ch, 20, controller.signal);
        expect.unreachable('should have rejected');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('channel_timeout');
      }
      // Aborting after timeout must not double-settle or throw.
      controller.abort('late abort');
    });

    it('only the aborted waiter rejects — another waiter on the same store still receives', async () => {
      const store = new ChannelStore();
      const ch = channel('two-waiters', {
        schema: z.number(),
        mode: 'queue',
      });
      const abortedController = new AbortController();
      const survivorController = new AbortController();
      const abortedRecv = store.recv(ch, 1_000, abortedController.signal);
      const survivorRecv = store.recv(ch, 1_000, survivorController.signal);

      abortedController.abort('one side down');
      try {
        await abortedRecv;
        expect.unreachable('should have rejected');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('cancelled');
      }

      store.send(ch, 7);
      expect(await survivorRecv).toBe(7);
    });

    it('topic-mode abort removes the subscriber; other subscribers still receive', async () => {
      const store = new ChannelStore();
      const ch = channel('topic-abort', {
        schema: z.string(),
        mode: 'topic',
      });
      const abortedController = new AbortController();
      const abortedRecv = store.recv(ch, 1_000, abortedController.signal);
      const survivorRecv = store.recv(ch, 1_000);

      abortedController.abort('listener gone');
      try {
        await abortedRecv;
        expect.unreachable('should have rejected');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('cancelled');
      }

      store.send(ch, 'still flowing');
      expect(await survivorRecv).toBe('still flowing');
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
