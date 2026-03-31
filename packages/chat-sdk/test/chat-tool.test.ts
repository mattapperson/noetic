import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { chatTool, clearChatToolRegistry, getChatToolRender } from '../src/chat-tool';

describe('chatTool', () => {
  test('creates a tool with name, description, input, output, execute', () => {
    clearChatToolRegistry();

    const t = chatTool({
      name: 'greet',
      description: 'Greet someone',
      input: z.object({
        name: z.string(),
      }),
      output: z.string(),
      execute: async (args) => `Hello, ${args.name}!`,
    });

    expect(t.name).toBe('greet');
    expect(t.description).toBe('Greet someone');
  });

  test('registers render function in registry', () => {
    clearChatToolRegistry();

    chatTool({
      name: 'search',
      description: 'Search',
      input: z.object({
        query: z.string(),
      }),
      output: z.string(),
      execute: async () => 'result',
      render: (output) => `Card: ${output}`,
    });

    const render = getChatToolRender('search');
    expect(render).toBeDefined();
    if (!render) {
      throw new Error('Expected render to be defined');
    }
    expect(render('test')).toBe('Card: test');
  });

  test('returns undefined render for unregistered tool', () => {
    clearChatToolRegistry();

    const render = getChatToolRender('nonexistent');
    expect(render).toBeUndefined();
  });

  test('tool without render has undefined render', () => {
    clearChatToolRegistry();

    chatTool({
      name: 'plain',
      description: 'Plain tool',
      input: z.object({
        x: z.number(),
      }),
      output: z.number(),
      execute: async (args) => args.x * 2,
    });

    const render = getChatToolRender('plain');
    expect(render).toBeUndefined();
  });

  test('clearChatToolRegistry removes all entries', () => {
    chatTool({
      name: 'temp',
      description: 'Temp',
      input: z.string(),
      output: z.string(),
      execute: async (x) => x,
      render: () => 'card',
    });

    expect(getChatToolRender('temp')).toBeDefined();

    clearChatToolRegistry();

    expect(getChatToolRender('temp')).toBeUndefined();
  });

  test('render can return null to skip posting', () => {
    clearChatToolRegistry();

    chatTool({
      name: 'maybe',
      description: 'Maybe render',
      input: z.string(),
      output: z.string(),
      execute: async (x) => x,
      render: () => null,
    });

    const render = getChatToolRender('maybe');
    if (!render) {
      throw new Error('Expected render to be defined');
    }
    expect(render('anything')).toBeNull();
  });

  test('preserves needsApproval flag', () => {
    clearChatToolRegistry();

    const t = chatTool({
      name: 'dangerous',
      description: 'Needs approval',
      input: z.string(),
      output: z.string(),
      execute: async (x) => x,
      needsApproval: true,
    });

    expect(t.needsApproval).toBe(true);
  });
});
