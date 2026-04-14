import { describe, expect, test } from 'bun:test';
import { estimateTokens } from '../../src/interpreter/message-helpers';
import { commitLayerUsage, computeLayerUsage } from '../../src/memory/layer-usage';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { InputMessageItem } from '../../src/types/items';
import type { RecallLayerOutput } from '../../src/types/runtime';
import { makeMockHarness } from '../_helpers';

function makeMessageItem(id: string, text: string): InputMessageItem {
  return {
    id,
    type: 'message',
    role: 'developer',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function makeRecall(layerId: string, text: string, tokens: number): RecallLayerOutput {
  return {
    layerId,
    items: [
      makeMessageItem(`${layerId}-msg`, text),
    ],
    tokenCount: tokens,
  };
}

function makeCtx(): ContextImpl {
  return new ContextImpl({
    harness: makeMockHarness(),
  });
}

describe('layer-usage', () => {
  test('breakdown reports layer tokens from recall results and history from itemLog', () => {
    const ctx = makeCtx();
    ctx.itemLog.append(makeMessageItem('history-1', 'free-floating user message'));

    const recallResults: RecallLayerOutput[] = [
      makeRecall('planMemory', 'plan summary', 42),
      makeRecall('workingMemory', 'scratchpad', 17),
    ];

    const usage = computeLayerUsage({
      ctx,
      modelId: 'test-model',
      instructions: 'system prompt body',
      tools: undefined,
      recallResults,
    });

    expect(usage.modelId).toBe('test-model');
    expect(usage.executionId).toBe(ctx.id);
    expect(usage.layers.length).toBe(2);
    // Sorted alphabetically by layerId.
    expect(usage.layers[0]?.layerId).toBe('planMemory');
    expect(usage.layers[0]?.tokenCount).toBe(42);
    expect(usage.layers[1]?.layerId).toBe('workingMemory');
    expect(usage.layers[1]?.tokenCount).toBe(17);
    expect(usage.systemPromptTokens).toBe(estimateTokens('system prompt body'));

    const expectedTotal =
      usage.systemPromptTokens + usage.toolsTokens + usage.historyTokens + 42 + 17;
    expect(usage.totalUsedTokens).toBe(expectedTotal);
    expect(usage.historyTokens).toBeGreaterThan(0);
  });

  test('layer entries preserve the recalled items so UI can show per-layer contents', () => {
    const ctx = makeCtx();
    const recallResults: RecallLayerOutput[] = [
      makeRecall('planMemory', 'plan summary', 42),
      makeRecall('workingMemory', 'scratchpad', 17),
    ];

    const usage = computeLayerUsage({
      ctx,
      modelId: 'm',
      instructions: undefined,
      tools: undefined,
      recallResults,
    });

    expect(usage.layers[0]?.layerId).toBe('planMemory');
    expect(usage.layers[0]?.items.length).toBe(1);
    const planItem = usage.layers[0]?.items[0];
    expect(planItem && 'id' in planItem && planItem.id).toBe('planMemory-msg');
    expect(usage.layers[1]?.layerId).toBe('workingMemory');
    expect(usage.layers[1]?.items.length).toBe(1);
    const wmItem = usage.layers[1]?.items[0];
    expect(wmItem && 'id' in wmItem && wmItem.id).toBe('workingMemory-msg');
  });

  test('commitLayerUsage writes onto ctx.lastLayerUsage', () => {
    const ctx = makeCtx();
    expect(ctx.lastLayerUsage).toBeUndefined();
    const usage = computeLayerUsage({
      ctx,
      modelId: 'm',
      instructions: undefined,
      tools: undefined,
      recallResults: [],
    });
    commitLayerUsage(ctx, usage);
    expect(ctx.lastLayerUsage).toBe(usage);
    // Side-effect rule: assert via ctx.itemLog.items as canonical observable.
    expect(ctx.itemLog.items.length).toBe(0);
  });

  test('empty recall + empty itemLog + no instructions yields totalUsedTokens=0', () => {
    const ctx = makeCtx();
    const usage = computeLayerUsage({
      ctx,
      modelId: 'm',
      instructions: undefined,
      tools: undefined,
      recallResults: [],
    });
    expect(usage.totalUsedTokens).toBe(0);
    expect(usage.layers.length).toBe(0);
    expect(usage.historyTokens).toBe(0);
  });
});
