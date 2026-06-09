import { describe, expect, it } from 'bun:test';
import type {
  ExecutionContext,
  FunctionCallItem,
  FunctionCallOutputItem,
  InputMessageItem,
  Item,
  ItemLog,
  LLMResponse,
  MessageItem,
  ScopedStorage,
} from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic-tools/platform-node';

import { reminderLayer } from '../src/memory/reminder-layer.js';
import type { ReminderLayerState } from '../src/memory/reminder-triggers.js';
import { BUILTIN_TRIGGERS, createReminderRegistry } from '../src/memory/reminder-triggers.js';

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
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
    ...overrides,
  };
}

/**
 * Minimal ScopedStorage backed by a per-key JSON shuttle. `JSON.parse(JSON.stringify(...))`
 * launders generic types across the interface boundary without a type assertion.
 */
function makeStorage(): ScopedStorage {
  const m = new Map<string, string>();
  return {
    async get<T>(k: string): Promise<T | null> {
      const raw = m.get(k);
      if (raw === undefined) {
        return null;
      }
      return JSON.parse(raw);
    },
    async set<T>(k: string, v: T): Promise<void> {
      m.set(k, JSON.stringify(v));
    },
    async delete(k: string): Promise<void> {
      m.delete(k);
    },
    async list(): Promise<string[]> {
      return Array.from(m.keys());
    },
  };
}

function makeLog(initialItems: Item[] = []): ItemLog {
  const items: Item[] = [
    ...initialItems,
  ];
  return {
    get items(): ReadonlyArray<Item> {
      return items;
    },
    append(item: Item): void {
      items.push(item);
    },
  };
}

function makeAssistantMessage(): MessageItem {
  const item: MessageItem = {
    id: crypto.randomUUID(),
    status: 'completed',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: 'ok',
        annotations: [],
        logprobs: [],
      },
    ],
  };
  return item;
}

function makeFunctionCall(name: string): FunctionCallItem {
  const item: FunctionCallItem = {
    id: crypto.randomUUID(),
    type: 'function_call',
    status: 'completed',
    name,
    callId: crypto.randomUUID(),
    arguments: '{}',
  };
  return item;
}

function makeFunctionOutput(output: string): FunctionCallOutputItem {
  return {
    id: crypto.randomUUID(),
    type: 'function_call_output',
    status: 'completed',
    callId: crypto.randomUUID(),
    output,
  };
}

function makeDummyResponse(): LLMResponse {
  return {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

function assistantContentText(msg: InputMessageItem | MessageItem): string {
  for (const part of msg.content ?? []) {
    if (part.type === 'input_text' && typeof part.text === 'string') {
      return part.text;
    }
    if (part.type === 'output_text' && typeof part.text === 'string') {
      return part.text;
    }
  }
  return '';
}

function asInputMessage(item: Item | undefined): InputMessageItem {
  if (item === undefined || item.type !== 'message') {
    throw new Error('expected message item');
  }
  if (item.role !== 'user' && item.role !== 'system' && item.role !== 'developer') {
    throw new Error(`expected input message role, got ${item.role}`);
  }
  return item;
}

//#region Registry tests

describe('createReminderRegistry', () => {
  it('preserves registration order', () => {
    const r = createReminderRegistry();
    r.register({
      id: 'a',
      minTurnsBetweenReminders: 1,
      timing: 'recall',
      shouldFire: () => null,
    });
    r.register({
      id: 'b',
      minTurnsBetweenReminders: 1,
      timing: 'recall',
      shouldFire: () => null,
    });
    expect(r.list().map((t) => t.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('throws on duplicate ids', () => {
    const r = createReminderRegistry();
    r.register({
      id: 'dup',
      minTurnsBetweenReminders: 1,
      timing: 'recall',
      shouldFire: () => null,
    });
    expect(() =>
      r.register({
        id: 'dup',
        minTurnsBetweenReminders: 1,
        timing: 'recall',
        shouldFire: () => null,
      }),
    ).toThrow();
  });
});

//#endregion

//#region Layer-level tests

describe('reminderLayer', () => {
  it('sits at Slot.REMINDER (80) and below STEERING', () => {
    const layer = reminderLayer({
      registry: createReminderRegistry(),
    });
    expect(layer.slot).toBe(Slot.REMINDER);
    expect(layer.slot).toBe(80);
    expect(layer.slot).toBeLessThan(Slot.STEERING);
  });

  it('store() increments assistantTurnCount by 1 for an assistant message', async () => {
    const layer = reminderLayer({
      registry: createReminderRegistry(),
    });
    if (layer.hooks.init === undefined || layer.hooks.store === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 't',
      ctx: makeCtx(),
    });
    const stored = await layer.hooks.store({
      newItems: [
        makeAssistantMessage(),
      ],
      log: makeLog(),
      response: makeDummyResponse(),
      ctx: makeCtx(),
      state,
    });
    expect(stored?.state.assistantTurnCount).toBe(1);
  });

  it('store() leaves assistantTurnCount at 0 for tool-output-only items', async () => {
    const layer = reminderLayer({
      registry: createReminderRegistry(),
    });
    if (layer.hooks.init === undefined || layer.hooks.store === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 't',
      ctx: makeCtx(),
    });
    const stored = await layer.hooks.store({
      newItems: [
        makeFunctionOutput('ok'),
      ],
      log: makeLog(),
      response: makeDummyResponse(),
      ctx: makeCtx(),
      state,
    });
    expect(stored?.state.assistantTurnCount).toBe(0);
  });

  it('store() tracks tool usage counts and the recent-tool-names list', async () => {
    const layer = reminderLayer({
      registry: createReminderRegistry(),
    });
    if (layer.hooks.init === undefined || layer.hooks.store === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 't',
      ctx: makeCtx(),
    });
    const stored = await layer.hooks.store({
      newItems: [
        makeFunctionCall('Bash'),
        makeFunctionCall('Bash'),
        makeFunctionCall('Read'),
      ],
      log: makeLog(),
      response: makeDummyResponse(),
      ctx: makeCtx(),
      state,
    });
    expect(stored?.state.toolUsageCounts.get('Bash')).toBe(2);
    expect(stored?.state.toolUsageCounts.get('Read')).toBe(1);
    expect(stored?.state.recentToolNames).toEqual([
      'Bash',
      'Bash',
      'Read',
    ]);
  });

  it('store() increments consecutiveErrorCount for error-looking outputs and resets on success', async () => {
    const layer = reminderLayer({
      registry: createReminderRegistry(),
    });
    if (layer.hooks.init === undefined || layer.hooks.store === undefined) {
      throw new Error('hooks missing');
    }
    let current: ReminderLayerState = (
      await layer.hooks.init({
        storage: makeStorage(),
        scopeKey: 't',
        ctx: makeCtx(),
      })
    ).state;
    for (let i = 0; i < 3; i++) {
      const stored = await layer.hooks.store({
        newItems: [
          makeFunctionOutput('Error: permission denied'),
        ],
        log: makeLog(),
        response: makeDummyResponse(),
        ctx: makeCtx(),
        state: current,
      });
      if (stored === undefined) {
        throw new Error('store returned undefined');
      }
      current = stored.state;
    }
    expect(current.consecutiveErrorCount).toBe(3);

    const stored = await layer.hooks.store({
      newItems: [
        makeFunctionOutput('ok'),
      ],
      log: makeLog(),
      response: makeDummyResponse(),
      ctx: makeCtx(),
      state: current,
    });
    expect(stored?.state.consecutiveErrorCount).toBe(0);
  });

  it('recall() wraps emitted reminders in <system-reminder> tags', async () => {
    const registry = createReminderRegistry();
    registry.register({
      id: 'always',
      minTurnsBetweenReminders: 1,
      timing: 'recall',
      shouldFire: () => 'hello world',
    });
    const layer = reminderLayer({
      registry,
    });
    if (layer.hooks.init === undefined || layer.hooks.recall === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 't',
      ctx: makeCtx(),
    });
    const result = await layer.hooks.recall({
      log: makeLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    if (result === null || typeof result === 'string') {
      throw new Error('expected RecallResult');
    }
    const item = asInputMessage(result.items[0]);
    expect(item.type).toBe('message');
    expect(item.role).toBe('developer');
    const text = assistantContentText(item);
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text).toContain('hello world');
    expect(text.endsWith('</system-reminder>')).toBe(true);
  });

  it('recall() respects the per-trigger throttle window', async () => {
    const registry = createReminderRegistry();
    registry.register({
      id: 'every-5',
      minTurnsBetweenReminders: 5,
      timing: 'recall',
      shouldFire: () => 'hi',
    });
    const layer = reminderLayer({
      registry,
    });
    if (
      layer.hooks.init === undefined ||
      layer.hooks.recall === undefined ||
      layer.hooks.store === undefined
    ) {
      throw new Error('hooks missing');
    }
    let state = (
      await layer.hooks.init({
        storage: makeStorage(),
        scopeKey: 't',
        ctx: makeCtx(),
      })
    ).state;

    const first = await layer.hooks.recall({
      log: makeLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    if (first === null || typeof first === 'string' || first.state === undefined) {
      throw new Error('expected non-null first recall');
    }
    state = first.state;

    // Advance 4 assistant turns — still under the 5-turn window.
    for (let i = 0; i < 4; i++) {
      const s = await layer.hooks.store({
        newItems: [
          makeAssistantMessage(),
        ],
        log: makeLog(),
        response: makeDummyResponse(),
        ctx: makeCtx(),
        state,
      });
      if (s === undefined) {
        throw new Error('store returned undefined');
      }
      state = s.state;
    }

    const stillThrottled = await layer.hooks.recall({
      log: makeLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    expect(stillThrottled).toBeNull();

    // One more turn → 5 turns since last fire → fires again.
    const s2 = await layer.hooks.store({
      newItems: [
        makeAssistantMessage(),
      ],
      log: makeLog(),
      response: makeDummyResponse(),
      ctx: makeCtx(),
      state,
    });
    if (s2 === undefined) {
      throw new Error('store returned undefined');
    }
    state = s2.state;

    const reopened = await layer.hooks.recall({
      log: makeLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 0,
    });
    expect(reopened).not.toBeNull();
  });

  it('onItemAppend() appends immediate-timing reminders after the incoming items', async () => {
    const registry = createReminderRegistry();
    registry.register({
      id: 'imm',
      minTurnsBetweenReminders: 1,
      timing: 'immediate',
      shouldFire: () => 'urgent',
    });
    registry.register({
      id: 'recall-only',
      minTurnsBetweenReminders: 1,
      timing: 'recall',
      shouldFire: () => 'ignored in immediate pass',
    });
    const layer = reminderLayer({
      registry,
    });
    if (layer.hooks.init === undefined || layer.hooks.onItemAppend === undefined) {
      throw new Error('hooks missing');
    }
    const { state } = await layer.hooks.init({
      storage: makeStorage(),
      scopeKey: 't',
      ctx: makeCtx(),
    });
    const incoming: Item[] = [
      makeFunctionOutput('something'),
    ];
    const result = await layer.hooks.onItemAppend({
      items: incoming,
      log: makeLog(),
      ctx: makeCtx(),
      state,
    });
    expect(result.items.length).toBe(2);
    expect(result.items[0]).toBe(incoming[0]);
    const tail = asInputMessage(result.items[1]);
    expect(tail.role).toBe('developer');
    const text = assistantContentText(tail);
    expect(text).toContain('urgent');
    expect(text).not.toContain('ignored in immediate pass');
  });
});

//#endregion

//#region Built-in trigger tests

describe('built-in triggers', () => {
  it('exports the expected trigger ids', () => {
    const ids = BUILTIN_TRIGGERS.map((t) => t.id).sort();
    expect(ids).toEqual([
      'agent-md-loaded',
      'consecutive-bash',
      'error-recovery',
      'long-conversation',
      'plan-mode-still-active',
    ]);
  });

  it('agent-md-loaded fires on turn 0 when agent-md layer has sources', () => {
    const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'agent-md-loaded');
    expect(trigger).toBeDefined();
    if (trigger === undefined) {
      throw new Error('unreachable');
    }
    const ctx = makeCtx({
      readLayerState: <T>(id: string): T | undefined => {
        if (id !== 'agent-md') {
          return undefined;
        }
        return JSON.parse(
          JSON.stringify({
            sources: [
              {
                path: '/proj/AGENT.md',
              },
            ],
          }),
        );
      },
    });
    const baseState: ReminderLayerState = {
      assistantTurnCount: 0,
      firedHistory: new Map(),
      toolUsageCounts: new Map(),
      recentToolNames: [],
      consecutiveErrorCount: 0,
    };
    const msg = trigger.shouldFire({
      state: baseState,
      ctx,
      log: makeLog(),
    });
    expect(typeof msg).toBe('string');
    expect(msg).toContain('AGENT.md');
  });

  it('long-conversation triggers at turn 40', () => {
    const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'long-conversation');
    if (trigger === undefined) {
      throw new Error('unreachable');
    }
    const ctx = makeCtx();
    const under: ReminderLayerState = {
      assistantTurnCount: 39,
      firedHistory: new Map(),
      toolUsageCounts: new Map(),
      recentToolNames: [],
      consecutiveErrorCount: 0,
    };
    expect(
      trigger.shouldFire({
        state: under,
        ctx,
        log: makeLog(),
      }),
    ).toBeNull();
    const at: ReminderLayerState = {
      ...under,
      assistantTurnCount: 40,
    };
    expect(
      trigger.shouldFire({
        state: at,
        ctx,
        log: makeLog(),
      }),
    ).not.toBeNull();
  });

  it('consecutive-bash fires after 3 Bash calls in a row', () => {
    const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'consecutive-bash');
    if (trigger === undefined) {
      throw new Error('unreachable');
    }
    const ctx = makeCtx();
    const mixed: ReminderLayerState = {
      assistantTurnCount: 10,
      firedHistory: new Map(),
      toolUsageCounts: new Map(),
      recentToolNames: [
        'Bash',
        'Read',
        'Bash',
      ],
      consecutiveErrorCount: 0,
    };
    expect(
      trigger.shouldFire({
        state: mixed,
        ctx,
        log: makeLog(),
      }),
    ).toBeNull();
    const streak: ReminderLayerState = {
      ...mixed,
      recentToolNames: [
        'Bash',
        'Bash',
        'Bash',
      ],
    };
    expect(
      trigger.shouldFire({
        state: streak,
        ctx,
        log: makeLog(),
      }),
    ).not.toBeNull();
  });

  it('error-recovery only fires after 3 consecutive errors', () => {
    const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'error-recovery');
    if (trigger === undefined) {
      throw new Error('unreachable');
    }
    const ctx = makeCtx();
    const two: ReminderLayerState = {
      assistantTurnCount: 3,
      firedHistory: new Map(),
      toolUsageCounts: new Map(),
      recentToolNames: [],
      consecutiveErrorCount: 2,
    };
    expect(
      trigger.shouldFire({
        state: two,
        ctx,
        log: makeLog(),
      }),
    ).toBeNull();
    const three: ReminderLayerState = {
      ...two,
      consecutiveErrorCount: 3,
    };
    expect(
      trigger.shouldFire({
        state: three,
        ctx,
        log: makeLog(),
      }),
    ).not.toBeNull();
  });

  it('plan-mode-still-active fires only when plan-memory reports planning mode', () => {
    const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'plan-mode-still-active');
    if (trigger === undefined) {
      throw new Error('unreachable');
    }
    const baseState: ReminderLayerState = {
      assistantTurnCount: 3,
      firedHistory: new Map(),
      toolUsageCounts: new Map(),
      recentToolNames: [],
      consecutiveErrorCount: 0,
    };

    const ctxNoPlan = makeCtx();
    expect(
      trigger.shouldFire({
        state: baseState,
        ctx: ctxNoPlan,
        log: makeLog(),
      }),
    ).toBeNull();

    const ctxInPlan = makeCtx({
      readLayerState: <T>(id: string): T | undefined => {
        if (id !== 'plan-memory') {
          return undefined;
        }
        return JSON.parse(
          JSON.stringify({
            session: {
              mode: 'planning',
            },
          }),
        );
      },
    });
    expect(
      trigger.shouldFire({
        state: baseState,
        ctx: ctxInPlan,
        log: makeLog(),
      }),
    ).not.toBeNull();

    const ctxNormal = makeCtx({
      readLayerState: <T>(id: string): T | undefined => {
        if (id !== 'plan-memory') {
          return undefined;
        }
        return JSON.parse(
          JSON.stringify({
            session: {
              mode: 'act',
            },
          }),
        );
      },
    });
    expect(
      trigger.shouldFire({
        state: baseState,
        ctx: ctxNormal,
        log: makeLog(),
      }),
    ).toBeNull();
  });
});

//#endregion

//#region Cross-layer-read safety (#5)

describe('agent-md-loaded — malformed sibling state', () => {
  function findTrigger(id: string) {
    const t = BUILTIN_TRIGGERS.find((x) => x.id === id);
    if (t === undefined) {
      throw new Error(`trigger ${id} not found`);
    }
    return t;
  }

  const emptyState: ReminderLayerState = {
    assistantTurnCount: 0,
    firedHistory: new Map(),
    toolUsageCounts: new Map(),
    recentToolNames: [],
    consecutiveErrorCount: 0,
  };

  const shapes: Array<{
    name: string;
    value: unknown;
  }> = [
    {
      name: 'non-object string',
      value: 'bogus',
    },
    {
      name: 'non-object number',
      value: 42,
    },
    {
      name: 'object with non-array sources',
      value: {
        sources: 'not-an-array',
      },
    },
    {
      name: 'object missing sources',
      value: {
        other: true,
      },
    },
    {
      name: 'null',
      value: null,
    },
  ];

  for (const shape of shapes) {
    it(`does not crash on ${shape.name} under 'agent-md'`, () => {
      const trigger = findTrigger('agent-md-loaded');
      const ctx = makeCtx({
        readLayerState: <T>(id: string): T | undefined => {
          if (id !== 'agent-md') {
            return undefined;
          }
          // Mock returns the attacker-shaped value through the unknown boundary
          // that `readLayerState` promises callers. Serialize → deserialize
          // launders the type without an `as` cast (test-helper convention).
          return JSON.parse(JSON.stringify(shape.value));
        },
      });
      // Must return null, not throw.
      expect(() =>
        trigger.shouldFire({
          state: emptyState,
          ctx,
          log: makeLog(),
        }),
      ).not.toThrow();
      expect(
        trigger.shouldFire({
          state: emptyState,
          ctx,
          log: makeLog(),
        }),
      ).toBeNull();
    });
  }

  it('does not crash on malformed plan-memory state', () => {
    const trigger = findTrigger('plan-mode-still-active');
    const ctx = makeCtx({
      readLayerState: <T>(id: string): T | undefined => {
        if (id !== 'plan-memory') {
          return undefined;
        }
        return JSON.parse(
          JSON.stringify({
            mode: 123,
          }),
        );
      },
    });
    expect(() =>
      trigger.shouldFire({
        state: emptyState,
        ctx,
        log: makeLog(),
      }),
    ).not.toThrow();
    expect(
      trigger.shouldFire({
        state: emptyState,
        ctx,
        log: makeLog(),
      }),
    ).toBeNull();
  });
});

//#endregion

//#region Boundary tests (#15)

describe('throttling thresholds — boundary matrix', () => {
  const mkCtx = () => makeCtx();

  function mkState(overrides: Partial<ReminderLayerState>): ReminderLayerState {
    return {
      assistantTurnCount: 0,
      firedHistory: new Map(),
      toolUsageCounts: new Map(),
      recentToolNames: [],
      consecutiveErrorCount: 0,
      ...overrides,
    };
  }

  type Case = {
    label: string;
    state: ReminderLayerState;
    expected: 'fires' | 'null';
  };

  const longConvoCases: Case[] = [
    {
      label: '39 (N-1)',
      state: mkState({
        assistantTurnCount: 39,
      }),
      expected: 'null',
    },
    {
      label: '40 (N)',
      state: mkState({
        assistantTurnCount: 40,
      }),
      expected: 'fires',
    },
    {
      label: '41 (N+1)',
      state: mkState({
        assistantTurnCount: 41,
      }),
      expected: 'fires',
    },
  ];
  describe.each(longConvoCases)('long-conversation @ turn $label', ({ state, expected }) => {
    it(`is ${expected}`, () => {
      const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'long-conversation');
      if (trigger === undefined) {
        throw new Error('unreachable');
      }
      const result = trigger.shouldFire({
        state,
        ctx: mkCtx(),
        log: makeLog(),
      });
      if (expected === 'fires') {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  });

  const errCases: Case[] = [
    {
      label: '2 (N-1)',
      state: mkState({
        consecutiveErrorCount: 2,
      }),
      expected: 'null',
    },
    {
      label: '3 (N)',
      state: mkState({
        consecutiveErrorCount: 3,
      }),
      expected: 'fires',
    },
    {
      label: '4 (N+1)',
      state: mkState({
        consecutiveErrorCount: 4,
      }),
      expected: 'fires',
    },
  ];
  describe.each(errCases)('error-recovery @ streak $label', ({ state, expected }) => {
    it(`is ${expected}`, () => {
      const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'error-recovery');
      if (trigger === undefined) {
        throw new Error('unreachable');
      }
      const result = trigger.shouldFire({
        state,
        ctx: mkCtx(),
        log: makeLog(),
      });
      if (expected === 'fires') {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  });

  const bashCases: Case[] = [
    {
      label: '2 (N-1)',
      state: mkState({
        recentToolNames: [
          'Bash',
          'Bash',
        ],
      }),
      expected: 'null',
    },
    {
      label: '3 (N)',
      state: mkState({
        recentToolNames: [
          'Bash',
          'Bash',
          'Bash',
        ],
      }),
      expected: 'fires',
    },
    {
      label: '3 + non-Bash interleaved',
      state: mkState({
        recentToolNames: [
          'Bash',
          'Bash',
          'Read',
          'Bash',
        ],
      }),
      expected: 'null',
    },
  ];
  describe.each(bashCases)('consecutive-bash $label', ({ state, expected }) => {
    it(`is ${expected}`, () => {
      const trigger = BUILTIN_TRIGGERS.find((t) => t.id === 'consecutive-bash');
      if (trigger === undefined) {
        throw new Error('unreachable');
      }
      const result = trigger.shouldFire({
        state,
        ctx: mkCtx(),
        log: makeLog(),
      });
      if (expected === 'fires') {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  });
});

//#endregion
