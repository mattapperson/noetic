import { describe, expect, it } from 'bun:test';
import type { AgentHarnessContract, Context, ContextHarness } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { ChannelStore } from '../../src/runtime/channel-store';

const status = channel('status', {
  schema: z.enum([
    'running',
    'done',
  ]),
  mode: 'value',
});

/**
 * Compile-time checks: the channel alone fixes the payload type, so a wider
 * value (a plain `string`, or an unrelated literal) must not widen `T`.
 * These bodies are never called — `tsc` is the assertion.
 */
function checkContextSend(ctx: Context, loose: string): void {
  void ctx.send(status, 'done');
  // @ts-expect-error a plain string must not widen the channel's literal union
  void ctx.send(status, loose);
  // @ts-expect-error a literal outside the union is rejected
  void ctx.send(status, 'nope');
}

function checkHarnessSend({
  harness,
  contextHarness,
  ctx,
  loose,
}: {
  harness: AgentHarnessContract;
  contextHarness: ContextHarness;
  ctx: Context;
  loose: string;
}): void {
  void harness.send(status, 'running', ctx);
  // @ts-expect-error a plain string must not widen the channel's literal union
  void harness.send(status, loose, ctx);
  // @ts-expect-error a plain string must not widen the channel's literal union
  void contextHarness.send(status, loose, ctx);
}

function checkStoreSend(store: ChannelStore, loose: string): void {
  void store.send(status, 'done');
  // @ts-expect-error a plain string must not widen the channel's literal union
  void store.send(status, loose);
}

describe('channel payload typing', () => {
  it('accepts a value inside the channel literal union', async () => {
    const store = new ChannelStore();
    await store.send(status, 'done');
    expect(store.tryRecv(status)).toBe('done');

    expect([
      checkContextSend,
      checkHarnessSend,
      checkStoreSend,
    ]).toHaveLength(3);
  });
});
