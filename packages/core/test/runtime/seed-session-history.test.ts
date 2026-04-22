import { describe, expect, it } from 'bun:test';
import { AgentHarness } from '../../src/runtime/agent-harness';
import { ItemSchema } from '../../src/schemas/item';
import type { LLMResponse } from '../../src/types/common';
import type { Item } from '../../src/types/items';
import type { ContextMemory } from '../../src/types/memory';
import type { CallModelRequest } from '../../src/types/runtime';
import type { Step } from '../../src/types/step';
import { makeMessage, textOnlyResponse } from '../_helpers';

const echoStep: Step<ContextMemory, string, string> = {
  kind: 'llm',
  id: 'echo',
  model: 'test/echo',
  tools: [],
};

function itemIds(items: ReadonlyArray<Item>): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if ('id' in item && typeof item.id === 'string') {
      ids.push(item.id);
    }
  }
  return ids;
}

describe('AgentHarness.seedSessionHistory()', () => {
  it('pre-populates session history so the next turn includes seeded items', async () => {
    const captured: Item[][] = [];
    const callModel = async (request: CallModelRequest): Promise<LLMResponse> => {
      captured.push([
        ...request.items,
      ]);
      return textOnlyResponse('ok');
    };

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: callModel,
    });

    const priorUser = makeMessage('user', 'prior question', 'seed-user-1');
    const priorAssistant = makeMessage('assistant', 'prior answer', 'seed-assistant-1');

    harness.seedSessionHistory('thread-resume', [
      priorUser,
      priorAssistant,
    ]);
    await harness.execute('new question', {
      threadId: 'thread-resume',
      messageId: 'new-1',
    });
    await harness.getAgentResponse({
      threadId: 'thread-resume',
    });

    expect(captured).toHaveLength(1);
    const sentIds = itemIds(captured[0]);
    expect(sentIds).toContain('seed-user-1');
    expect(sentIds).toContain('seed-assistant-1');
  });

  it('replaces previously-seeded items when called again on the same thread', async () => {
    const captured: Item[][] = [];
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: async (request) => {
        captured.push([
          ...request.items,
        ]);
        return textOnlyResponse('ok');
      },
    });

    harness.seedSessionHistory('t', [
      makeMessage('user', 'first seed', 'first-seed'),
    ]);
    harness.seedSessionHistory('t', [
      makeMessage('user', 'second seed', 'second-seed'),
    ]);
    await harness.execute('now', {
      threadId: 't',
    });
    await harness.getAgentResponse({
      threadId: 't',
    });

    const sentIds = itemIds(captured[0]);
    expect(sentIds).toContain('second-seed');
    expect(sentIds).not.toContain('first-seed');
  });

  it('isolates seeded history by threadId', async () => {
    const captured: Item[][] = [];
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: async (request) => {
        captured.push([
          ...request.items,
        ]);
        return textOnlyResponse('ok');
      },
    });

    harness.seedSessionHistory('t-a', [
      makeMessage('user', 'history for a', 'only-a'),
    ]);
    harness.seedSessionHistory('t-b', [
      makeMessage('user', 'history for b', 'only-b'),
    ]);

    await harness.execute('go', {
      threadId: 't-a',
    });
    await harness.getAgentResponse({
      threadId: 't-a',
    });
    await harness.execute('go', {
      threadId: 't-b',
    });
    await harness.getAgentResponse({
      threadId: 't-b',
    });

    expect(captured).toHaveLength(2);
    const idsA = itemIds(captured[0]);
    const idsB = itemIds(captured[1]);
    expect(idsA).toContain('only-a');
    expect(idsA).not.toContain('only-b');
    expect(idsB).toContain('only-b');
    expect(idsB).not.toContain('only-a');
  });
});

describe('ItemSchema', () => {
  it('accepts a well-formed InputMessageItem', () => {
    const item = makeMessage('user', 'hi', 'u-1');
    expect(() => ItemSchema.parse(item)).not.toThrow();
  });

  it('accepts a well-formed MessageItem', () => {
    const item = makeMessage('assistant', 'hi', 'a-1');
    expect(() => ItemSchema.parse(item)).not.toThrow();
  });

  it('rejects values without a type discriminant', () => {
    expect(() => ItemSchema.parse({})).toThrow();
    expect(() =>
      ItemSchema.parse({
        foo: 'bar',
      }),
    ).toThrow();
  });

  it('rejects non-object values', () => {
    expect(() => ItemSchema.parse(null)).toThrow();
    expect(() => ItemSchema.parse(42)).toThrow();
    expect(() => ItemSchema.parse('string')).toThrow();
  });

  it('rejects empty-string type', () => {
    expect(() =>
      ItemSchema.parse({
        type: '',
      }),
    ).toThrow();
  });
});
