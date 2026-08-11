/**
 * Regression for #48 — context layers must init/recall/persist on the bare
 * `harness.run()` path (and therefore `parseAndRunWorkflow`), not only via the
 * high-level `execute()` / SessionRunner path.
 *
 * When `storage` and `memory` are both configured, calling `.run(step, input,
 * ctx)` must hydrate prior layer state from storage (init), recall it into the
 * model context, and persist updated state back to storage — so state
 * rehydrates on the next `.run()` (next process / DO turn).
 */
import { describe, expect, it } from 'bun:test';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type { LLMResponse, StepLoop } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { loop } from '../../src/builders/loop-builder';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { any } from '../../src/until/combinators';
import { until } from '../../src/until/predicates';
import { createScriptedCallModel, makeStorage } from '../_helpers';

/** Minimal ReAct-style loop: an LLM step iterated until no tool calls or the step cap. */
function reactLoop(): StepLoop<ContextData, string, string> {
  return loop<ContextData, string, string>({
    id: 'react-loop',
    steps: [
      step.llm({
        id: 'react-step',
        model: 'gpt-4',
        tools: [],
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(5)),
  });
}

interface CountState {
  count: number;
}

/**
 * Thread-scoped layer that hydrates a counter from durable storage (init),
 * surfaces it (recall), and bumps + persists it after every turn (store).
 */
function counterLayer(): ContextLayer<CountState> {
  return {
    id: 'counter',
    slot: 100,
    scope: 'thread',
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<CountState>('state');
        return {
          state: saved ?? {
            count: 0,
          },
        };
      },
      async recall({ state }) {
        return `Prior turn count: ${state.count}.`;
      },
      async store({ state }) {
        return {
          state: {
            count: (state?.count ?? 0) + 1,
          },
        };
      },
    },
  };
}

/** A single assistant message terminates the loop (no tool calls). */
function singleMessageScript(text: string): LLMResponse[] {
  return [
    {
      items: [
        {
          id: 'msg-1',
          status: 'completed',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
            },
          ],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 10,
      },
    },
  ];
}

describe('#48: memory init/recall/persist on harness.run()', () => {
  it('persists layer state to storage after a bare run()', async () => {
    const storage = makeStorage();
    const harness = new AgentHarness({
      name: 'a',
      params: {},
      contextLayers: [
        counterLayer(),
      ],
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: createScriptedCallModel(singleMessageScript('ok')),
    });
    const ctx = harness.createContext({
      threadId: 'thread-1',
    });

    await harness.run(reactLoop(), 'hello', ctx);

    // init + store mirror must have written the counter to durable storage.
    const keys = await storage.list('layers/');
    expect(keys.length).toBeGreaterThan(0);
    const persisted = await storage.get<CountState>(keys[0] ?? '');
    expect(persisted).toEqual({
      count: 1,
    });
  });

  it('rehydrates persisted state on the next process/harness run()', async () => {
    const storage = makeStorage();

    // Turn 1 — fresh harness, count 0 → 1, persisted.
    const harness1 = new AgentHarness({
      name: 'a',
      params: {},
      contextLayers: [
        counterLayer(),
      ],
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: createScriptedCallModel(singleMessageScript('ok')),
    });
    const ctx1 = harness1.createContext({
      threadId: 'thread-1',
    });
    await harness1.run(reactLoop(), 'remember', ctx1);

    // Turn 2 — brand new harness (new process), same storage + threadId.
    const harness2 = new AgentHarness({
      name: 'a',
      params: {},
      contextLayers: [
        counterLayer(),
      ],
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: createScriptedCallModel(singleMessageScript('ok')),
    });
    const ctx2 = harness2.createContext({
      threadId: 'thread-1',
    });
    await harness2.run(reactLoop(), 'recall', ctx2);

    // init rehydrated count=1, store bumped to 2.
    const keys = await storage.list('layers/');
    const persisted = await storage.get<CountState>(keys[0] ?? '');
    expect(persisted).toEqual({
      count: 2,
    });
  });

  it('persists memory via parseAndRunWorkflow (dispatches through run())', async () => {
    const storage = makeStorage();
    const harness = new AgentHarness({
      name: 'a',
      params: {},
      contextLayers: [
        counterLayer(),
      ],
      environment: {
        storage: {
          adapter: storage,
        },
      },
      _testCallModel: createScriptedCallModel(singleMessageScript('ok')),
    });
    const ctx = harness.createContext({
      threadId: 'thread-1',
    });

    await parseAndRunWorkflow({
      json: {
        version: 1,
        root: {
          kind: 'llm',
          id: 'root',
          model: 'gpt-4',
          instructions: 'reply',
        },
      },
      harness,
      ctx,
      tools: [],
      input: 'remember my name is Matt',
    });

    const keys = await storage.list('layers/');
    expect(keys.length).toBeGreaterThan(0);
    const persisted = await storage.get<CountState>(keys[0] ?? '');
    expect(persisted).toEqual({
      count: 1,
    });
  });
});
