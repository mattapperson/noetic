import { describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { ChannelStore } from '../../src/runtime/channel-store';

const EXEC = 'exec-1';

function queueChannel(capacity?: number) {
  return channel('q', {
    schema: z.number(),
    mode: 'queue',
    capacity,
    external: true,
  });
}

function topicChannel() {
  return channel('t', {
    schema: z.number(),
    mode: 'topic',
    external: true,
  });
}

function valueChannel() {
  return channel('v', {
    schema: z.number(),
    mode: 'value',
    external: true,
  });
}

/** Yields to the microtask queue so pending promise reactions run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChannelStore.subscribe', () => {
  describe('queue mode', () => {
    it('delivers sends in FIFO order and retains pre-next values', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1);
      await store.send(ch, 2);
      expect((await stream.next()).value).toBe(1);
      expect((await stream.next()).value).toBe(2);
    });

    it('a parked next() is woken by a later send', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      const pending = stream.next();
      await store.send(ch, 7);
      expect((await pending).value).toBe(7);
    });

    it('external dequeue frees a parked internal sender at capacity', async () => {
      const store = new ChannelStore();
      const ch = queueChannel(1);
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1);
      let parkedResolved = false;
      const parked = store
        .send(ch, 2, {
          timeout: 0,
        })
        .then(() => {
          parkedResolved = true;
        });
      await tick();
      expect(parkedResolved).toBe(false);

      expect((await stream.next()).value).toBe(1);
      await parked;
      expect(parkedResolved).toBe(true);
      expect((await stream.next()).value).toBe(2);
    });

    it('boundary: capacity N-1 / N / N+1 sends around a subscriber', async () => {
      const store = new ChannelStore();
      const ch = queueChannel(2);
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1); // N-1: buffered
      await store.send(ch, 2); // N: buffered at capacity
      const overflow = store.send(ch, 3, {
        timeout: 0,
      }); // N+1: parks
      expect((await stream.next()).value).toBe(1);
      expect((await stream.next()).value).toBe(2);
      await overflow;
      expect((await stream.next()).value).toBe(3);
    });

    it('an earlier internal recv waiter wins over a later external next()', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const recvPromise = store.recv(ch, 5_000);
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      const streamNext = stream.next();
      await store.send(ch, 1);
      expect(await recvPromise).toBe(1);
      await store.send(ch, 2);
      expect((await streamNext).value).toBe(2);
    });

    it('a parked external next() never rejects with channel_timeout', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      let settled = false;
      const pending = stream.next().then((r) => {
        settled = true;
        return r;
      });
      await tick();
      expect(settled).toBe(false);
      store.closeExecution(EXEC);
      expect((await pending).done).toBe(true);
    });
  });

  describe('topic mode', () => {
    it('buffers values sent between next() calls (non-lossy)', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1);
      await store.send(ch, 2);
      expect((await stream.next()).value).toBe(1);
      expect((await stream.next()).value).toBe(2);
    });

    it('every subscriber receives every value', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const a = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      const b = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 5);
      expect((await a.next()).value).toBe(5);
      expect((await b.next()).value).toBe(5);
    });

    it('internal one-shot recv still works alongside an external subscriber', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      const recvPromise = store.recv(ch, 5_000);
      await store.send(ch, 9);
      expect(await recvPromise).toBe(9);
      expect((await stream.next()).value).toBe(9);
    });

    it('does not replay values sent before subscribing', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      await store.send(ch, 1);
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 2);
      expect((await stream.next()).value).toBe(2);
    });

    it('drops the oldest value and warns when the buffer overflows', async () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const store = new ChannelStore();
        const ch = topicChannel();
        const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
        for (let i = 0; i < 1_001; i++) {
          await store.send(ch, i);
        }
        expect(warn).toHaveBeenCalled();
        expect((await stream.next()).value).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('value mode', () => {
    it('yields the current value immediately, then updates', async () => {
      const store = new ChannelStore();
      const ch = valueChannel();
      await store.send(ch, 1);
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      expect((await stream.next()).value).toBe(1);
      await store.send(ch, 2);
      expect((await stream.next()).value).toBe(2);
    });

    it('conflates rapid sends to the newest value', async () => {
      const store = new ChannelStore();
      const ch = valueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1);
      await store.send(ch, 2);
      await store.send(ch, 3);
      expect((await stream.next()).value).toBe(3);
    });

    it('is non-consuming: tryRecv still sees the value', async () => {
      const store = new ChannelStore();
      const ch = valueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 4);
      expect((await stream.next()).value).toBe(4);
      expect(store.tryRecv(ch)).toBe(4);
    });
  });

  describe('lifecycle', () => {
    it('closeExecution drains buffered values then ends the iterator', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1);
      store.closeExecution(EXEC);
      expect((await stream.next()).value).toBe(1);
      const end = await stream.next();
      expect(end.done).toBe(true);
      expect((await stream.next()).done).toBe(true);
    });

    it('closeExecution ends parked iterators in all modes', async () => {
      const store = new ChannelStore();
      const queue = store.subscribe(queueChannel(), EXEC)[Symbol.asyncIterator]();
      const topic = store.subscribe(topicChannel(), EXEC)[Symbol.asyncIterator]();
      const value = store.subscribe(valueChannel(), EXEC)[Symbol.asyncIterator]();
      const pending = [
        queue.next(),
        topic.next(),
        value.next(),
      ];
      store.closeExecution(EXEC);
      for (const result of await Promise.all(pending)) {
        expect(result.done).toBe(true);
      }
    });

    it('re-subscribing after a handle-observed close is immediately done', async () => {
      const store = new ChannelStore();
      store.getHandle(topicChannel(), EXEC);
      store.subscribe(topicChannel(), EXEC);
      store.closeExecution(EXEC);
      const stream = store.subscribe(topicChannel(), EXEC)[Symbol.asyncIterator]();
      expect((await stream.next()).done).toBe(true);
    });

    it('closing a never-observed execution records nothing', () => {
      // A session harness closes one root id per turn; only ids someone holds
      // a handle or stream for are recorded (bounded memory). A handle taken
      // after the fact therefore reads open.
      const store = new ChannelStore();
      store.closeExecution('never-observed');
      const handle = store.getHandle(queueChannel(), 'never-observed');
      expect(handle.closed).toBe(false);
    });

    it('a closed queue subscriber drains what was queued at close, then ends — later sends stay in the queue', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      await store.send(ch, 1);
      store.closeExecution(EXEC);
      await store.send(ch, 2);
      expect((await stream.next()).value).toBe(1);
      expect((await stream.next()).done).toBe(true);
      // The post-close send belongs to whoever consumes the channel next.
      expect(store.tryRecv(ch)).toBe(2);
    });

    it('openExecution clears a previous closure so a reused id works again', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const handle = store.getHandle(ch, EXEC);
      store.closeExecution(EXEC);
      expect(handle.closed).toBe(true);
      store.openExecution(EXEC);
      expect(handle.closed).toBe(false);
      handle.send(9);
      expect(store.tryRecv(ch)).toBe(9);
    });

    it('closeExecution only ends subscribers of that execution', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const mine = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      const other = store.subscribe(ch, 'exec-2')[Symbol.asyncIterator]();
      store.closeExecution('exec-2');
      expect((await other.next()).done).toBe(true);
      await store.send(ch, 1);
      expect((await mine.next()).value).toBe(1);
    });

    it('iterator.return() unregisters: later sends do not buffer', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const iterable = store.subscribe(ch, EXEC);
      const stream = iterable[Symbol.asyncIterator]();
      await store.send(ch, 1);
      expect((await stream.next()).value).toBe(1);
      assert(stream.return);
      expect((await stream.return()).done).toBe(true);
      await store.send(ch, 2);
      expect((await stream.next()).done).toBe(true);
    });

    it('iterator.return() removes a parked queue waiter so sends buffer instead', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      const stream = store.subscribe(ch, EXEC)[Symbol.asyncIterator]();
      const pending = stream.next();
      assert(stream.return);
      await stream.return();
      expect((await pending).done).toBe(true);
      // The dead iterator's waiter is gone — the send lands in the queue.
      await store.send(ch, 8);
      expect(store.tryRecv(ch)).toBe(8);
    });

    it('for-await breaks cleanly via return()', async () => {
      const store = new ChannelStore();
      const ch = topicChannel();
      const iterable = store.subscribe(ch, EXEC);
      await store.send(ch, 1);
      await store.send(ch, 2);
      const seen: number[] = [];
      for await (const value of iterable) {
        seen.push(value);
        break;
      }
      expect(seen).toEqual([
        1,
      ]);
      await store.send(ch, 3);
      const after = await iterable[Symbol.asyncIterator]().next();
      expect(after.done).toBe(true);
    });
  });

  describe('internal semantics unchanged with a subscriber attached', () => {
    it('internal recv still times out with channel_timeout', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      store.subscribe(ch, EXEC);
      try {
        await store.recv(ch, 10);
        throw new Error('expected channel_timeout');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('channel_timeout');
      }
    });

    it('internal recv still rejects cancelled on abort', async () => {
      const store = new ChannelStore();
      const ch = queueChannel();
      store.subscribe(ch, EXEC);
      const controller = new AbortController();
      const pending = store.recv(ch, 5_000, controller.signal);
      controller.abort('stop');
      try {
        await pending;
        throw new Error('expected cancelled');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('cancelled');
      }
    });
  });
});
