import { describe, it, expect } from 'bun:test';
import { ItemLogImpl } from '../../src/runtime/item-log-impl';
import type { MessageItem, FunctionCallItem, FunctionCallOutputItem, ReasoningItem, ExtensionItem } from '../../src/types/items';

const makeMessage = (id: string, role: 'user' | 'assistant' = 'user'): MessageItem => ({
  id,
  type: 'message',
  status: 'completed',
  role,
  content: [{ type: 'input_text', text: `hello ${id}` }],
});

const makeFunctionCall = (id: string): FunctionCallItem => ({
  id,
  type: 'function_call',
  status: 'completed',
  call_id: `call_${id}`,
  name: 'myFunc',
  arguments: '{}',
});

const makeFunctionCallOutput = (id: string): FunctionCallOutputItem => ({
  id,
  type: 'function_call_output',
  status: 'completed',
  call_id: `call_${id}`,
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
    const msg = makeMessage('m1');
    log.append(msg);
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toBe(msg);
  });

  it('appends multiple different item types', () => {
    const log = new ItemLogImpl();
    const msg = makeMessage('m1');
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
    log.append(makeMessage('m1'));

    // The returned array should be frozen or otherwise prevent mutation
    const items = log.items;
    expect(() => {
      (items as unknown[]).push(makeMessage('m2'));
    }).toThrow();
  });

  it('multi-type coexistence — all types present and in order', () => {
    const log = new ItemLogImpl();

    const msg = makeMessage('m1', 'assistant');
    const call = makeFunctionCall('f1');
    const output = makeFunctionCallOutput('f1');
    const reasoning: ReasoningItem = {
      id: 'r1',
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'output_text', text: 'thinking...' }],
    };
    const ext: ExtensionItem = {
      id: 'e1',
      type: 'custom_type',
      status: 'completed',
      payload: { foo: 'bar' },
    };

    log.append(msg);
    log.append(call);
    log.append(output);
    log.append(reasoning);
    log.append(ext);

    expect(log.items).toHaveLength(5);
    expect(log.items[0]).toBe(msg);
    expect(log.items[1]).toBe(call);
    expect(log.items[2]).toBe(output);
    expect(log.items[3]).toBe(reasoning);
    expect(log.items[4]).toBe(ext);

    // Verify types
    expect(log.items[0].type).toBe('message');
    expect(log.items[1].type).toBe('function_call');
    expect(log.items[2].type).toBe('function_call_output');
    expect(log.items[3].type).toBe('reasoning');
    expect(log.items[4].type).toBe('custom_type');
  });
});
