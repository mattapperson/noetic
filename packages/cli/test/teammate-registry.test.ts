import { describe, expect, test } from 'bun:test';
import type { DetachedHandle } from '@noetic-tools/core';
import { TeammateRegistry } from '../src/agents/registry-runtime.js';

function makeFakeHandle(id: string): DetachedHandle<string> {
  return {
    id,
    status: 'running',
    result: undefined,
    error: undefined,
    await: () => new Promise(() => undefined),
  };
}

describe('TeammateRegistry', () => {
  test('postNotice + drainNotices is FIFO and clears the queue', () => {
    const r = new TeammateRegistry();
    r.postNotice('first');
    r.postNotice('second');
    expect(r.drainNotices()).toEqual([
      'first',
      'second',
    ]);
    expect(r.drainNotices()).toEqual([]);
  });

  test('drainNotices returns empty array when queue is empty', () => {
    const r = new TeammateRegistry();
    expect(r.drainNotices()).toEqual([]);
  });

  test('registerById makes a handle findable by id', () => {
    const r = new TeammateRegistry();
    const h = makeFakeHandle('agent-x');
    r.registerById(h);
    expect(r.getById('agent-x')).toBe(h);
    expect(r.getById('missing')).toBeUndefined();
  });

  test('registerByName indexes by name AND by id', () => {
    const r = new TeammateRegistry();
    const handle = makeFakeHandle('agent-y');
    r.registerByName('researcher', {
      handle,
      inbox: [],
    });
    expect(r.getByName('researcher')?.handle).toBe(handle);
    expect(r.getByName('researcher')?.inbox).toEqual([]);
    expect(r.getById('agent-y')).toBe(handle);
    expect(r.listNames()).toEqual([
      'researcher',
    ]);
  });

  test('postInbound appends to the named teammate queue', () => {
    const r = new TeammateRegistry();
    r.registerByName('helper', {
      handle: makeFakeHandle('a-1'),
      inbox: [],
    });
    expect(r.postInbound('helper', 'hello')).toBe(true);
    expect(r.postInbound('helper', 'world')).toBe(true);
    expect(r.drainInbound('helper')).toEqual([
      'hello',
      'world',
    ]);
    // Second drain is empty.
    expect(r.drainInbound('helper')).toEqual([]);
  });

  test('postInbound returns false for unknown teammate (no mutation)', () => {
    const r = new TeammateRegistry();
    expect(r.postInbound('ghost', 'hi')).toBe(false);
    expect(r.drainInbound('ghost')).toEqual([]);
  });

  test('unregister removes by id and clears matching name entries', () => {
    const r = new TeammateRegistry();
    const handle = makeFakeHandle('agent-z');
    r.registerByName('helper', {
      handle,
      inbox: [],
    });
    expect(r.getByName('helper')).toBeDefined();
    r.unregister('agent-z');
    expect(r.getById('agent-z')).toBeUndefined();
    expect(r.getByName('helper')).toBeUndefined();
  });

  test('dropAll clears every map, the notice queue, and per-teammate inboxes', () => {
    const r = new TeammateRegistry();
    r.registerById(makeFakeHandle('a-1'));
    r.registerByName('b', {
      handle: makeFakeHandle('a-2'),
      inbox: [
        'queued',
      ],
    });
    r.postNotice('pending');

    r.dropAll();

    expect(r.getById('a-1')).toBeUndefined();
    expect(r.getById('a-2')).toBeUndefined();
    expect(r.getByName('b')).toBeUndefined();
    expect(r.listIds()).toEqual([]);
    expect(r.listNames()).toEqual([]);
    expect(r.drainNotices()).toEqual([]);
  });
});
