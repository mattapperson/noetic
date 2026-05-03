/**
 * End-to-end tests for memory layers using a real LLM via OpenRouter.
 *
 * These tests require OPENROUTER_API_KEY to be set in the environment.
 * They exercise real model calls to verify the memory layer system
 * works with actual LLM responses, not just mocked ones.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { OpenResponsesResult } from '@openrouter/agent';
import { frameworkCast } from '../../src/interpreter/framework-cast';

type OpenResponsesOutputItem = OpenResponsesResult['output'][number];

import {
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  storeLayers,
} from '../../src/memory/layer-lifecycle';
import { observationalMemory } from '../../src/memory/layers/observational-memory';
import { steering } from '../../src/memory/layers/steering';
import { workingMemory } from '../../src/memory/layers/working-memory';
import type { LLMResponse } from '../../src/types/common';
import type { ExecutionContext } from '../../src/types/memory';
import type { CallModelRequest } from '../../src/types/runtime';
import type { SteeringState } from '../../src/types/steering';
import { SteeringAction } from '../../src/types/steering';
import {
  isRecord,
  makeCtx,
  makeFunctionCall,
  makeItemLog,
  makeLLMResponse,
  makeStorage,
} from '../_helpers';

//#region Helpers

const HAS_API_KEY = Boolean(process.env.OPENROUTER_API_KEY);

/**
 * Creates an AgentHarness-compatible callModel that calls the OpenRouter API directly.
 * Returns undefined if no OPENROUTER_API_KEY is set.
 */
function createTestCallModel(): ((request: CallModelRequest) => Promise<LLMResponse>) | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  return async (request) => {
    const { OpenRouter } = await import('@openrouter/agent');
    const client = new OpenRouter({
      apiKey,
    });

    // Extract user message text from items
    const inputMessages = request.items
      .filter((i) => i.type === 'message' && 'content' in i && 'role' in i)
      .map((m) => {
        const parts: Array<{
          type: string;
          text?: string;
        }> = 'content' in m && Array.isArray(m.content) ? m.content : [];
        const role = 'role' in m ? m.role : 'user';
        return frameworkCast<{
          role: 'user' | 'system' | 'developer';
          content: string;
        }>({
          role,
          content: parts
            .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text)
            .map((c) => c.text ?? '')
            .join(''),
        });
      });

    type OpenRouterInput = Parameters<typeof client.callModel>[0]['input'];
    const sdkResult = client.callModel({
      model: request.model,
      input: frameworkCast<OpenRouterInput>(inputMessages),
    });
    const response = await sdkResult.getResponse();

    // Extract text from output items (outputText is often undefined)
    const text = response.output
      .filter((o: OpenResponsesOutputItem) => o.type === 'message' && 'content' in o)
      .flatMap((m: OpenResponsesOutputItem) => {
        if (!('content' in m)) {
          return [];
        }
        const parts: Array<{
          type: string;
          text?: string;
        }> = Array.isArray(m.content) ? m.content : [];
        return parts;
      })
      .filter((c: { type: string; text?: string }) => c.type === 'output_text' && c.text)
      .map((c: { type: string; text?: string }) => c.text ?? '')
      .join('');
    return {
      items: [
        {
          id: crypto.randomUUID(),
          status: 'completed' as const,
          type: 'message' as const,
          role: 'assistant' as const,
          content: [
            {
              type: 'output_text' as const,
              text,
            },
          ],
        },
      ],
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
    };
  };
}

const testCallModel = createTestCallModel();

/** Creates an ExecutionContext with a real OpenRouter callModel. */
function makeCtxWithRealCallModel(overrides?: Partial<ExecutionContext>): ExecutionContext {
  assert(testCallModel !== undefined);
  return makeCtx({
    callModel: testCallModel,
    ...overrides,
  });
}

//#endregion

//#region Steering with Real LLM

describe('Steering: real LLM eval', () => {
  test.skipIf(!HAS_API_KEY)('sync steering rule returns ALLOW for safe tool call', async () => {
    const layer = steering({
      rules: [
        {
          id: 'safety-check',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt:
              'You are a safety checker. If the tool call is a safe read-only operation, respond with exactly "ALLOW". If it could cause harm, respond with "DENY". Only respond with one word.',
            model: 'openai/gpt-4o-mini',
          },
        },
      ],
    });

    const ctx = makeCtxWithRealCallModel();
    const store = createLayerStateStore();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const state = store.get<SteeringState>(ctx.executionId, layer.id);
    assert(state !== undefined);

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'readFile',
      toolArgs: {
        path: '/tmp/notes.txt',
      },
      ctx,
      state,
    });

    expect(result.decision.action).toBe(SteeringAction.Allow);
  });

  test.skipIf(!HAS_API_KEY)('sync steering rule returns DENY for dangerous tool call', async () => {
    const layer = steering({
      rules: [
        {
          id: 'safety-check',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt:
              'You are a safety checker. If the tool call deletes data or is destructive, respond with exactly "DENY dangerous operation". Otherwise respond with "ALLOW". Only respond with one of those two options.',
            model: 'openai/gpt-4o-mini',
          },
        },
      ],
    });

    const ctx = makeCtxWithRealCallModel();
    const store = createLayerStateStore();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const state = store.get<SteeringState>(ctx.executionId, layer.id);
    assert(state !== undefined);

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'deleteDatabase',
      toolArgs: {
        database: 'production',
        confirm: true,
      },
      ctx,
      state,
    });

    expect(result.decision.action).toBe(SteeringAction.Deny);
    expect(result.decision.guidance).toBeDefined();
  });

  test.skipIf(!HAS_API_KEY)('sync steering rule returns GUIDE with guidance text', async () => {
    const layer = steering({
      rules: [
        {
          id: 'guidance-check',
          appliesTo: [
            'beforeToolCall',
          ],
          llmEval: {
            mode: 'sync',
            prompt:
              'You are a code review assistant. For any tool call, respond with exactly "GUIDE: Consider adding error handling" — always give that exact response.',
            model: 'openai/gpt-4o-mini',
          },
        },
      ],
    });

    const ctx = makeCtxWithRealCallModel();
    const store = createLayerStateStore();
    const storage = makeStorage();

    await initLayers({
      layers: [
        layer,
      ],
      ctx,
      storage,
      store,
    });

    const state = store.get<SteeringState>(ctx.executionId, layer.id);
    assert(state !== undefined);

    const result = await layer.hooks.beforeToolCall!({
      toolName: 'writeCode',
      toolArgs: {
        file: 'main.ts',
      },
      ctx,
      state,
    });

    expect(result.decision.action).toBe(SteeringAction.Guide);
    expect(result.decision.guidance).toBeDefined();
    assert(result.decision.guidance !== undefined);
    expect(result.decision.guidance.length).toBeGreaterThan(0);
  });
});

//#endregion

//#region Observational Memory with Real Observer

describe('Observational Memory: real LLM observer', () => {
  test.skipIf(!HAS_API_KEY)(
    'LLM-based observer distills buffer into meaningful observations',
    async () => {
      assert(testCallModel !== undefined);

      const layer = observationalMemory({
        bufferThreshold: 10, // Low threshold to trigger quickly
        observer: async (buffer) => {
          assert(testCallModel !== undefined);
          const response = await testCallModel({
            model: 'openai/gpt-4o-mini',
            items: [
              {
                id: 'obs-prompt',
                status: 'completed',
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: `Summarize these observations into 1-2 bullet points. Return ONLY the bullet points, one per line, starting with "- ".\n\nObservations:\n${buffer.join('\n')}`,
                  },
                ],
              },
            ],
          });

          // Extract text from response
          const text = response.items
            .filter((i) => i.type === 'message' && 'content' in i)
            .flatMap((m) => {
              if (!('content' in m)) {
                return [];
              }
              const parts: Array<{
                type: string;
                text?: string;
              }> = Array.isArray(m.content) ? m.content : [];
              return parts;
            })
            .filter((c) => c.type === 'output_text' && c.text)
            .map((c) => c.text ?? '')
            .join('');

          return text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('- '))
            .map((l) => l.slice(2));
        },
      });

      const store = createLayerStateStore();
      const ctx = makeCtx();
      const storage = makeStorage();

      await initLayers({
        layers: [
          layer,
        ],
        ctx,
        storage,
        store,
      });

      // Store a response with enough text to trigger the observer
      const response = makeLLMResponse(
        'The user asked about authentication. I analyzed the codebase and found three auth methods: JWT, OAuth, and session-based. The JWT implementation has a known vulnerability in token refresh.',
      );

      const log = makeItemLog();
      await storeLayers({
        layers: [
          layer,
        ],
        response,
        ctx,
        log,
        store,
        storage: makeStorage(),
      });

      // Recall via lifecycle function so state is read from the store
      const budgets = new Map([
        [
          layer.id,
          2e3,
        ],
      ]);
      const recallResults = await recallLayers({
        layers: [
          layer,
        ],
        query: '',
        ctx,
        log,
        budgets,
        store,
      });

      // ~50 tokens in the message exceeds the bufferThreshold of 10, so observer must fire
      expect(recallResults.length).toBe(1);
      expect(recallResults[0].items.length).toBeGreaterThan(0);
    },
  );
});

//#endregion

//#region Working Memory Full Lifecycle

describe('Working Memory: full lifecycle', () => {
  test('init→recall(empty)→store→recall(populated)→store(update)→recall(merged)→dispose', async () => {
    const wm = workingMemory({
      scope: 'resource',
    });
    const store = createLayerStateStore();
    const ctx = makeCtx();
    const storage = makeStorage();
    const log = makeItemLog();

    // 1. Init
    await initLayers({
      layers: [
        wm,
      ],
      ctx,
      storage,
      store,
    });
    expect(store.get<string>(ctx.executionId, wm.id)).toBe('');

    // 2. Recall (empty) → null
    const budgets = new Map([
      [
        wm.id,
        1.5e3,
      ],
    ]);
    const recall1 = await recallLayers({
      layers: [
        wm,
      ],
      query: '',
      ctx,
      log,
      budgets,
      store,
    });
    expect(recall1.length).toBe(0);

    // 3. Store with updateWorkingMemory function call
    const response1 = makeLLMResponse('Setting up plan.', {
      items: [
        makeFunctionCall(
          'updateWorkingMemory',
          '{"plan":"Analyze auth system","status":"in-progress","findings":[]}',
        ),
      ],
    });
    await storeLayers({
      layers: [
        wm,
      ],
      response: response1,
      ctx,
      log,
      store,
      storage: makeStorage(),
    });

    // 4. Recall (populated)
    const recall2 = await recallLayers({
      layers: [
        wm,
      ],
      query: '',
      ctx,
      log,
      budgets,
      store,
    });
    expect(recall2.length).toBe(1);
    const wmItems = recall2[0].items;
    expect(wmItems.length).toBeGreaterThan(0);

    // Verify the content contains the plan
    const recalledContent = wmItems
      .filter((i) => i.type === 'message' && 'content' in i)
      .flatMap((m) => {
        if (!('content' in m)) {
          return [];
        }
        const parts: Array<{
          type: string;
          text?: string;
        }> = Array.isArray(m.content) ? m.content : [];
        return parts;
      })
      .filter((c) => c.type === 'input_text' && c.text)
      .map((c) => c.text ?? '')
      .join('');
    expect(recalledContent).toContain('Analyze auth system');

    // 5. Store with update (shallow merge)
    const response2 = makeLLMResponse('Found issues.', {
      items: [
        makeFunctionCall(
          'updateWorkingMemory',
          '{"status":"complete","findings":["JWT refresh vuln"]}',
        ),
      ],
    });
    await storeLayers({
      layers: [
        wm,
      ],
      response: response2,
      ctx,
      log,
      store,
      storage: makeStorage(),
    });

    // 6. Recall (merged)
    const recall3 = await recallLayers({
      layers: [
        wm,
      ],
      query: '',
      ctx,
      log,
      budgets,
      store,
    });
    expect(recall3.length).toBe(1);

    // Verify state was merged
    const state = store.get(ctx.executionId, wm.id);
    assert(isRecord(state));
    expect(state.plan).toBe('Analyze auth system'); // preserved from first store
    expect(state.status).toBe('complete'); // updated
    assert(Array.isArray(state.findings));
    expect(state.findings).toEqual([
      'JWT refresh vuln',
    ]); // replaced (shallow merge)

    // 7. Dispose
    await disposeLayers({
      layers: [
        wm,
      ],
      ctx,
      store,
    });
    expect(store.get(ctx.executionId, wm.id)).toBeUndefined();
  });
});

//#endregion
