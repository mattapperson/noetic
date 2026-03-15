import { describe, it, expect, spyOn } from 'bun:test';
import { ChannelStore } from '../../src/runtime/channel-store';
import { channel } from '../../src/builders/channel-builder';
import { isOrchidError, OrchidErrorImpl } from '../../src/errors/orchid-error';
import { z } from 'zod';

describe('ChannelStore', () => {
  describe('value mode', () => {
    it('last-write-wins', () => {
      const store = new ChannelStore();
      const ch = channel('test', { schema: z.number(), mode: 'value' });
      store.send(ch, 1);
      store.send(ch, 2);
      expect(store.tryRecv(ch)).toBe(2);
    });

    it('send wakes recv', async () => {
      const store = new ChannelStore();
      const ch = channel('test', { schema: z.string(), mode: 'value' });
      const promise = store.recv(ch, 5000);
      store.send(ch, 'hello');
      expect(await promise).toBe('hello');
    });

    it('tryRecv returns null when no value set', () => {
      const store = new ChannelStore();
      const ch = channel('test', { schema: z.string(), mode: 'value' });
      expect(store.tryRecv(ch)).toBeNull();
    });

    it('tryRecv returns current value without consuming it', () => {
      const store = new ChannelStore();
      const ch = channel('test', { schema: z.number(), mode: 'value' });
      store.send(ch, 42);
      expect(store.tryRecv(ch)).toBe(42);
      expect(store.tryRecv(ch)).toBe(42);
    });
  });

  describe('queue mode', () => {
    it('FIFO ordering', () => {
      const store = new ChannelStore();
      const ch = channel('q', { schema: z.number(), mode: 'queue' });
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
      const ch = channel('q', { schema: z.string(), mode: 'queue' });
      const promise = store.recv(ch, 5000);
      store.send(ch, 'msg');
      expect(await promise).toBe('msg');
    });

    it('tryRecv returns null when empty', () => {
      const store = new ChannelStore();
      const ch = channel('q', { schema: z.string(), mode: 'queue' });
      expect(store.tryRecv(ch)).toBeNull();
    });
  });

  describe('topic mode', () => {
    it('all receivers get every message', async () => {
      const store = new ChannelStore();
      const ch = channel('topic', { schema: z.string(), mode: 'topic' });
      const p1 = store.recv(ch, 5000);
      const p2 = store.recv(ch, 5000);
      store.send(ch, 'broadcast');
      expect(await p1).toBe('broadcast');
      expect(await p2).toBe('broadcast');
    });

    it('tryRecv always returns null', () => {
      const store = new ChannelStore();
      const ch = channel('topic', { schema: z.string(), mode: 'topic' });
      store.send(ch, 'hello');
      expect(store.tryRecv(ch)).toBeNull();
    });
  });

  describe('timeout', () => {
    it('recv throws channel_timeout', async () => {
      const store = new ChannelStore();
      const ch = channel('t', { schema: z.string(), mode: 'queue' });
      try {
        await store.recv(ch, 50);
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        expect((e as OrchidErrorImpl).orchidError.kind).toBe('channel_timeout');
      }
    });

    it('value mode recv throws channel_timeout when no value', async () => {
      const store = new ChannelStore();
      const ch = channel('v', { schema: z.string(), mode: 'value' });
      try {
        await store.recv(ch, 50);
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        expect((e as OrchidErrorImpl).orchidError.kind).toBe('channel_timeout');
      }
    });

    it('topic mode recv throws channel_timeout when no message', async () => {
      const store = new ChannelStore();
      const ch = channel('tp', { schema: z.string(), mode: 'topic' });
      try {
        await store.recv(ch, 50);
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        expect((e as OrchidErrorImpl).orchidError.kind).toBe('channel_timeout');
      }
    });
  });

  describe('external channels', () => {
    it('getHandle returns typed handle', () => {
      const store = new ChannelStore();
      const ch = channel('ext', { schema: z.string(), mode: 'queue', external: true });
      const handle = store.getHandle(ch as any, 'exec-1');
      expect(handle.closed).toBe(false);
      expect(handle.channel).toBe(ch);
    });

    it('handle.send delivers to channel', () => {
      const store = new ChannelStore();
      const ch = channel('ext', { schema: z.string(), mode: 'queue', external: true });
      const handle = store.getHandle(ch as any, 'exec-1');
      handle.send('hello');
      expect(store.tryRecv(ch)).toBe('hello');
    });

    it('handle.closed reflects execution completion', () => {
      const store = new ChannelStore();
      const ch = channel('ext', { schema: z.string(), mode: 'queue', external: true });
      const handle = store.getHandle(ch as any, 'exec-1');
      expect(handle.closed).toBe(false);
      store.closeExecution('exec-1');
      expect(handle.closed).toBe(true);
    });

    it('post-completion send throws channel_closed', () => {
      const store = new ChannelStore();
      const ch = channel('ext', { schema: z.string(), mode: 'queue', external: true });
      const handle = store.getHandle(ch as any, 'exec-1');
      store.closeExecution('exec-1');
      try {
        handle.send('hello');
        expect(true).toBe(false);
      } catch (e) {
        expect(isOrchidError(e)).toBe(true);
        expect((e as OrchidErrorImpl).orchidError.kind).toBe('channel_closed');
      }
    });
  });

  describe('back-pressure', () => {
    it('drops oldest on full external channel queue', () => {
      const store = new ChannelStore();
      const ch = channel('ext-q', { schema: z.number(), mode: 'queue', capacity: 3, external: true });
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
      const ch = channel('overflow-test', { schema: z.number(), mode: 'queue', capacity: 2 });
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
      const ch = channel('int-q', { schema: z.number(), mode: 'queue', capacity: 2 });
      store.send(ch, 1);
      store.send(ch, 2);
      store.send(ch, 3); // At capacity, should be dropped for internal
      expect(store.tryRecv(ch)).toBe(1);
      expect(store.tryRecv(ch)).toBe(2);
      expect(store.tryRecv(ch)).toBeNull();
    });
  });
});
