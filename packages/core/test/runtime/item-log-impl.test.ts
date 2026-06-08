import { describe, expect, it } from 'bun:test';
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  InputMessageItem,
  Item,
  MessageItem,
  ReasoningItem,
  ServerToolItem,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { ItemLogImpl } from '../../src/runtime/item-log-impl';

const makeInputMessage = (
  id: string,
  role: 'user' | 'system' | 'developer' = 'user',
): InputMessageItem => ({
  id,
  type: 'message',
  status: 'completed',
  role,
  content: [
    {
      type: 'input_text',
      text: `hello ${id}`,
    },
  ],
});

const makeAssistantMessage = (id: string): MessageItem =>
  frameworkCast<MessageItem>({
    id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: `response ${id}`,
      },
    ],
  });

const makeFunctionCall = (id: string): FunctionCallItem => ({
  id,
  type: 'function_call',
  status: 'completed',
  callId: `call_${id}`,
  name: 'myFunc',
  arguments: '{}',
});

const makeFunctionCallOutput = (id: string): FunctionCallOutputItem => ({
  id,
  type: 'function_call_output',
  status: 'completed',
  callId: `call_${id}`,
  output: '{"result": true}',
});

describe('ItemLogImpl', () => {
  it('creates an empty ItemLog', () => {
    const log = new ItemLogImpl();
    expect(log.items).toEqual([]);
    expect(log.items.length).toBe(0);
  });

  it('appends a MessageItem and it appears in items', () => {
    const log = new ItemLogImpl();
    const msg = makeInputMessage('m1');
    log.append(msg);
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toBe(msg);
  });

  it('appends multiple different item types', () => {
    const log = new ItemLogImpl();
    const msg = makeInputMessage('m1');
    const call = makeFunctionCall('f1');
    const output = makeFunctionCallOutput('f1');

    log.append(msg);
    log.append(call);
    log.append(output);

    expect(log.items).toHaveLength(3);
    expect(log.items[0]).toBe(msg);
    expect(log.items[1]).toBe(call);
    expect(log.items[2]).toBe(output);
  });

  it('items array is readonly — cannot push directly', () => {
    const log = new ItemLogImpl();
    log.append(makeInputMessage('m1'));

    // The returned array should be frozen or otherwise prevent mutation
    const items = log.items;
    expect(() => {
      Array.prototype.push.call(items, makeInputMessage('m2'));
    }).toThrow();
  });

  it('multi-type coexistence — all types present and in order', () => {
    const log = new ItemLogImpl();

    const msg = makeAssistantMessage('m1');
    const call = makeFunctionCall('f1');
    const output = makeFunctionCallOutput('f1');
    const reasoning = frameworkCast<ReasoningItem>({
      id: 'r1',
      type: 'reasoning',
      status: 'completed',
      summary: [
        {
          type: 'summary_text',
          text: 'thinking...',
        },
      ],
    });
    const ext = frameworkCast<ServerToolItem>({
      type: 'openrouter:datetime',
      id: 'e1',
      status: 'completed',
    });

    log.append(msg);
    log.append(call);
    log.append(output);
    log.append(reasoning);
    log.append(frameworkCast<Item>(ext));

    expect(log.items).toHaveLength(5);
    expect(log.items[0]).toBe(msg);
    expect(log.items[1]).toBe(call);
    expect(log.items[2]).toBe(output);
    expect(log.items[3]).toBe(reasoning);

    // Verify types
    expect(log.items[0].type).toBe('message');
    expect(log.items[1].type).toBe('function_call');
    expect(log.items[2].type).toBe('function_call_output');
    expect(log.items[3].type).toBe('reasoning');
    expect(log.items[4].type).toBe('openrouter:datetime');
  });
});
