import { describe, expect, it } from 'bun:test';

import type { ExecutionContext, ItemLog, ScopedStorage } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter, Slot } from '@noetic/core';

import type { AgentInstructionResult } from '../src/config/agent-md-loader.js';
import { agentMdLayer } from '../src/memory/agent-md-layer.js';

function makeCtx(): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    fs: createLocalFsAdapter(),
    shell: createLocalShellAdapter(),
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(_id: string): T | undefined => undefined,
  };
}

function makeStorage(): ScopedStorage {
  const store = new Map<string, string>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      if (raw === undefined) {
        return null;
      }
      return JSON.parse(raw);
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<string[]> {
      return Array.from(store.keys());
    },
  };
}

function makeEmptyLog(): ItemLog {
  const items: never[] = [];
  return {
    get items(): ReadonlyArray<never> {
      return items;
    },
    append(): void {},
  };
}

describe('agentMdLayer', () => {
  it('sits one slot ahead of OBSERVATIONS (195)', () => {
    const layer = agentMdLayer({
      loader: async () => ({
        text: 'x',
        sources: [],
        totalBytes: 0,
        totalCapExceeded: false,
      }),
    });
    expect(layer.slot).toBe(Slot.OBSERVATIONS - 5);
    expect(layer.slot).toBe(195);
  });

  it('returns null from recall when no sources were loaded', async () => {
    const layer = agentMdLayer({
      loader: async () => ({
        text: '',
        sources: [],
        totalBytes: 0,
        totalCapExceeded: false,
      }),
    });
    if (layer.hooks.init === undefined || layer.hooks.recall === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 'test',
      ctx: makeCtx(),
    });
    const result = await layer.hooks.recall({
      log: makeEmptyLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    expect(result).toBeNull();
  });

  it('renders a header plus the loaded text when sources exist', async () => {
    const loaderResult: AgentInstructionResult = {
      text: 'Contents of /proj/AGENT.md (project instructions, checked into the codebase):\n\nSample body.',
      sources: [
        {
          path: '/proj/AGENT.md',
          displayPath: '/proj/AGENT.md',
          origin: 'project',
          kind: 'agent-md',
          roleDescription: 'project instructions, checked into the codebase',
          content: 'Sample body.',
          wasTruncated: false,
          byteSize: 12,
          resolvedImports: [],
        },
      ],
      totalBytes: 12,
      totalCapExceeded: false,
    };
    const layer = agentMdLayer({
      loader: async () => loaderResult,
    });
    if (layer.hooks.init === undefined || layer.hooks.recall === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 'test',
      ctx: makeCtx(),
    });
    const result = await layer.hooks.recall({
      log: makeEmptyLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    expect(typeof result).toBe('string');
    if (typeof result !== 'string') {
      throw new Error('unreachable');
    }
    expect(result.startsWith('# Project & User Instructions (AGENT.md)')).toBe(true);
    expect(result).toContain('Contents of /proj/AGENT.md');
    expect(result).toContain('Sample body.');
  });

  it('appends a cap-note when totalCapExceeded is true', async () => {
    const loaderResult: AgentInstructionResult = {
      text: 'Contents of /proj/AGENT.md (project instructions, checked into the codebase):\n\nx',
      sources: [
        {
          path: '/proj/AGENT.md',
          displayPath: '/proj/AGENT.md',
          origin: 'project',
          kind: 'agent-md',
          roleDescription: 'project instructions, checked into the codebase',
          content: 'x',
          wasTruncated: false,
          byteSize: 1,
          resolvedImports: [],
        },
      ],
      totalBytes: 1,
      totalCapExceeded: true,
    };
    const layer = agentMdLayer({
      loader: async () => loaderResult,
    });
    if (layer.hooks.init === undefined || layer.hooks.recall === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 'test',
      ctx: makeCtx(),
    });
    const result = await layer.hooks.recall({
      log: makeEmptyLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    if (typeof result !== 'string') {
      throw new Error('unreachable');
    }
    expect(result).toContain('omitted due to the 60KB total cap');
  });
});
