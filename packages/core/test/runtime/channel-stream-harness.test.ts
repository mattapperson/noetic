import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextMemory } from '@noetic-tools/memory';
import type { Step } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { AgentHarness } from '../../src/harness/agent-harness';

const approvals = channel('approvals', {
  schema: z.string(),
  mode: 'queue',
  external: true,
});

function sendingStep(values: string[]): Step<ContextMemory, string, string> {
  return {
    kind: 'run',
    id: 'sender',
    execute: async (input: string, ctx) => {
      for (const value of values) {
        await ctx.send(approvals, value);
      }
      return input;
    },
  };
}

describe('AgentHarness.getChannelStream', () => {
  it('streams values a step sends and ends when run() completes', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const stream = harness.getChannelStream(approvals, ctx.id);

    await harness.run(
      sendingStep([
        'a',
        'b',
      ]),
      'go',
      ctx,
    );

    const seen: string[] = [];
    for await (const value of stream) {
      seen.push(value);
    }
    expect(seen).toEqual([
      'a',
      'b',
    ]);
  });

  it('run() completion flips handle.closed and post-run send throws channel_closed', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const handle = harness.getChannelHandle(approvals, ctx.id);
    expect(handle.closed).toBe(false);

    await harness.run(sendingStep([]), 'go', ctx);

    expect(handle.closed).toBe(true);
    try {
      handle.send('late');
      throw new Error('expected channel_closed');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('channel_closed');
    }
  });

  it('a nested run() re-entering the same root context does not close early', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const handle = harness.getChannelHandle(approvals, ctx.id);

    const inner = sendingStep([
      'inner',
    ]);
    const outer: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'outer',
      execute: async (input: string, innerCtx) => {
        await innerCtx.harness.run(inner, input, innerCtx);
        expect(handle.closed).toBe(false);
        await innerCtx.send(approvals, 'outer');
        return input;
      },
    };

    // `run()` on the root context re-enters through patterns exactly like
    // this; only the outermost completion may close the channels.
    const stream = harness.getChannelStream(approvals, ctx.id);
    await harness.run(outer, 'go', ctx);
    expect(handle.closed).toBe(true);

    const seen: string[] = [];
    for await (const value of stream) {
      seen.push(value);
    }
    expect(seen).toEqual([
      'inner',
      'outer',
    ]);
  });

  it('sequential run() on the same root context reopens its channels', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const handle = harness.getChannelHandle(approvals, ctx.id);

    await harness.run(sendingStep([]), 'first', ctx);
    expect(handle.closed).toBe(true);

    const observer: Step<ContextMemory, string, string> = {
      kind: 'run',
      id: 'observer',
      execute: async (input: string) => {
        // Mid-run the reused id must be open again for external senders.
        expect(handle.closed).toBe(false);
        handle.send('mid-run');
        return input;
      },
    };
    await harness.run(observer, 'second', ctx);
    expect(handle.closed).toBe(true);
  });

  it('cancel() ends a live stream without throwing into the consumer', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const stream = harness.getChannelStream(approvals, ctx.id);

    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await harness.cancel(ctx, 'user stop');

    expect((await pending).done).toBe(true);
  });

  it('a child-context run does not close the root execution channels', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const handle = harness.getChannelHandle(approvals, ctx.id);

    const child = harness.createContext({
      parent: ctx,
    });
    await harness.run(
      sendingStep([
        'from-child',
      ]),
      'go',
      child,
    );

    expect(handle.closed).toBe(false);
  });
});
