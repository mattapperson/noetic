import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import { historyWindow } from '../../src/memory/layers/history-window';
import type { Item } from '../../src/types/items';
import {
  getItemId,
  makeCtx,
  makeFunctionCall,
  makeFunctionCallOutput,
  makeMessage,
} from '../_helpers';

function buildItems(roles: ReadonlyArray<'user' | 'assistant'>): Item[] {
  return roles.map((role, i) => {
    if (role === 'assistant') {
      return makeMessage('assistant', `${role}-${i}`, `msg-${i}`);
    }
    return makeMessage('user', `${role}-${i}`, `msg-${i}`);
  });
}

const STUB_CTX = makeCtx();

async function project(layer: ReturnType<typeof historyWindow>, items: Item[]): Promise<Item[]> {
  if (!layer.hooks.projectHistory) {
    throw new Error('layer missing projectHistory hook');
  }
  const result = await layer.hooks.projectHistory({
    items,
    ctx: STUB_CTX,
    state: null,
  });
  return [
    ...result.items,
  ];
}

describe('historyWindow', () => {
  describe('caps trailing items', () => {
    it('slices to last maxItems when over the cap', async () => {
      const layer = historyWindow({
        maxItems: 4,
      });
      const items = [
        ...buildItems([
          'user',
          'assistant',
        ]),
        ...buildItems([
          'user',
          'assistant',
          'user',
          'assistant',
        ]),
      ];
      const projected = await project(layer, items);
      expect(projected).toHaveLength(4);
      expect(projected[0]).toBe(items[2]);
      expect(projected[3]).toBe(items[5]);
    });

    it('returns input unchanged when items.length <= maxItems', async () => {
      const layer = historyWindow({
        maxItems: 10,
      });
      const items = buildItems([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      const projected = await project(layer, items);
      expect(projected).toEqual(items);
    });

    it('honors a custom maxItems', async () => {
      const layer = historyWindow({
        maxItems: 2,
      });
      const items = buildItems([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      const projected = await project(layer, items);
      expect(projected).toHaveLength(2);
    });
  });

  describe('minimum-exchange guarantee', () => {
    it('expands backward to include a user message when slice has only assistant', async () => {
      const layer = historyWindow({
        maxItems: 2,
      });
      const items: Item[] = [
        makeMessage('user', 'first', 'u-0'),
        makeMessage('assistant', 'reply-1', 'a-0'),
        makeMessage('assistant', 'reply-2', 'a-1'),
      ];
      const projected = await project(layer, items);
      // slice(-2) gives only assistants; expansion pulls in the user msg.
      expect(projected).toHaveLength(3);
      expect(getItemId(projected[0])).toBe('u-0');
    });

    it('expands backward to include an assistant message when slice has only user', async () => {
      const layer = historyWindow({
        maxItems: 2,
      });
      const items: Item[] = [
        makeMessage('assistant', 'reply', 'a-0'),
        makeMessage('user', 'q-1', 'u-0'),
        makeMessage('user', 'q-2', 'u-1'),
      ];
      const projected = await project(layer, items);
      expect(projected).toHaveLength(3);
      expect(getItemId(projected[0])).toBe('a-0');
    });

    it('does not expand when slice already contains both roles', async () => {
      const layer = historyWindow({
        maxItems: 2,
      });
      const items: Item[] = [
        makeMessage('user', 'old', 'u-old'),
        makeMessage('assistant', 'old', 'a-old'),
        makeMessage('user', 'new', 'u-new'),
        makeMessage('assistant', 'new', 'a-new'),
      ];
      const projected = await project(layer, items);
      expect(projected).toHaveLength(2);
      expect(getItemId(projected[0])).toBe('u-new');
    });
  });

  describe('pair integrity', () => {
    it('strips orphaned function_call when its output is just past the slice', async () => {
      const call = makeFunctionCall('read', '{}', 'fc-1');
      const output = makeFunctionCallOutput(call.callId, 'ok', 'fco-1');
      const layer = historyWindow({
        maxItems: 3,
      });
      const items: Item[] = [
        makeMessage('user', 'q', 'u-0'),
        makeMessage('assistant', 'thinking', 'a-0'),
        call,
        output,
        makeMessage('user', 'next', 'u-1'),
        makeMessage('assistant', 'answer', 'a-1'),
      ];
      // Naive slice-3 = [call, output, u-1] — but minimum-exchange expansion
      // pulls back at least one assistant. The slice end keeps the most recent
      // assistant via expansion or normal truncation; whatever is included must
      // not contain orphan tool-call/output items.
      const projected = await project(layer, items);
      const calls = projected.filter((i) => i.type === 'function_call');
      const outs = projected.filter((i) => i.type === 'function_call_output');
      const callIds = new Set(calls.map((c) => (c.type === 'function_call' ? c.callId : '')));
      const outIds = new Set(outs.map((o) => (o.type === 'function_call_output' ? o.callId : '')));
      for (const id of callIds) {
        expect(outIds.has(id)).toBe(true);
      }
      for (const id of outIds) {
        expect(callIds.has(id)).toBe(true);
      }
    });

    it('drops a function_call_output left behind when its call is dropped by the slice', async () => {
      const call = makeFunctionCall('read', '{}', 'fc-orphan');
      const output = makeFunctionCallOutput(call.callId, 'ok', 'fco-orphan');
      const layer = historyWindow({
        maxItems: 3,
      });
      const items: Item[] = [
        call, // dropped by slice
        output, // becomes orphan after slice
        makeMessage('user', 'now', 'u-0'),
        makeMessage('assistant', 'reply', 'a-0'),
      ];
      const projected = await project(layer, items);
      const hasOrphanOutput = projected.some(
        (i) => i.type === 'function_call_output' && i.callId === 'call_fc-orphan',
      );
      expect(hasOrphanOutput).toBe(false);
    });
  });

  describe('opt-in semantics', () => {
    it('default maxItems is 40', async () => {
      const layer = historyWindow();
      const items: Item[] = Array.from(
        {
          length: 50,
        },
        (_, i) => {
          if (i % 2 === 0) {
            return makeMessage('user', `m-${i}`, `id-${i}`);
          }
          return makeMessage('assistant', `m-${i}`, `id-${i}`);
        },
      );
      const projected = await project(layer, items);
      expect(projected.length).toBeLessThanOrEqual(40);
      const last = projected[projected.length - 1];
      expect(last !== undefined && getItemId(last)).toBe('id-49');
    });
  });

  describe('maxItems validation', () => {
    it('rejects maxItems below the floor', () => {
      try {
        historyWindow({
          maxItems: 1,
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticConfigError(e));
        expect(e.code).toBe('INVALID_HISTORY_WINDOW_MAX_ITEMS');
      }
    });

    it('rejects zero, negative, and NaN', () => {
      for (const bad of [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        try {
          historyWindow({
            maxItems: bad,
          });
          expect.unreachable(`should have thrown for ${bad}`);
        } catch (e) {
          assert(isNoeticConfigError(e));
          expect(e.code).toBe('INVALID_HISTORY_WINDOW_MAX_ITEMS');
        }
      }
    });

    it('rejects non-integer values', () => {
      try {
        historyWindow({
          maxItems: 3.5,
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticConfigError(e));
      }
    });

    it('rejects values above the ceiling', () => {
      try {
        historyWindow({
          maxItems: 1e4 + 1,
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticConfigError(e));
      }
    });
  });

  describe('boundary behaviour around maxItems', () => {
    it('passes input through by reference at maxItems - 1', async () => {
      const layer = historyWindow({
        maxItems: 4,
      });
      const items: Item[] = buildItems([
        'user',
        'assistant',
        'user',
      ]);
      const result = await layer.hooks.projectHistory!({
        items,
        ctx: STUB_CTX,
        state: null,
      });
      // Same reference — pure pass-through, no copy.
      expect(result.items).toBe(items);
    });

    it('passes input through by reference at exactly maxItems', async () => {
      const layer = historyWindow({
        maxItems: 4,
      });
      const items: Item[] = buildItems([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      const result = await layer.hooks.projectHistory!({
        items,
        ctx: STUB_CTX,
        state: null,
      });
      expect(result.items).toBe(items);
    });

    it('returns a fresh array (not the input) at maxItems + 1', async () => {
      const layer = historyWindow({
        maxItems: 4,
      });
      const items: Item[] = buildItems([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
      const result = await layer.hooks.projectHistory!({
        items,
        ctx: STUB_CTX,
        state: null,
      });
      expect(result.items).not.toBe(items);
      // Storage isolation: input array contents are unchanged.
      expect(items.length).toBe(5);
      expect(getItemId(items[0])).toBe('msg-0');
    });
  });
});
