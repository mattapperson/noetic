import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isOrchidError } from '../../src/errors/orchid-error';
import type { CallModelParams } from '../../src/interpreter/execute-llm';
import { executeSpawn } from '../../src/interpreter/execute-spawn';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { LLMResponse } from '../../src/types/common';
import type { MessageItem } from '../../src/types/items';
import type { StepSpawn } from '../../src/types/step';
import { simpleExecute } from '../_helpers';

describe('executeSpawn - summary contextOut', () => {
  it('makes summary LLM call after child execution', async () => {
    const parentCtx = new ContextImpl();
    let summaryCallMade = false;

    let capturedArgs: CallModelParams | undefined;
    const mockCallModel = async (p: CallModelParams): Promise<LLMResponse> => {
      capturedArgs = p;
      summaryCallMade = true;
      return {
        items: [
          {
            id: 'sum',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Child did X and Y',
              },
            ],
          } as MessageItem,
        ],
        usage: {
          inputTokens: 50,
          outputTokens: 20,
        },
      };
    };

    const step: StepSpawn<string, string> = {
      kind: 'spawn',
      id: 'test',
      child: {
        kind: 'run',
        id: 'child',
        execute: async (i: string) => `result: ${i}`,
      },
      contextIn: {
        strategy: 'fresh',
      },
      contextOut: {
        strategy: 'summary',
        prompt: 'Summarize this',
      },
    };

    const result = await executeSpawn(step, 'input', parentCtx, simpleExecute, mockCallModel);
    expect(summaryCallMade).toBe(true);
    expect(result).toBe('Child did X and Y');
    assert(capturedArgs !== undefined);
    expect(capturedArgs.items).toBeDefined();
  });

  it('uses custom model for summary', async () => {
    let usedModel = '';
    const mockCallModel = async (p: CallModelParams): Promise<LLMResponse> => {
      usedModel = p.model;
      return {
        items: [
          {
            id: 's',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'summary',
              },
            ],
          } as MessageItem,
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
        },
      };
    };

    const step: StepSpawn<string, string> = {
      kind: 'spawn',
      id: 'test',
      child: {
        kind: 'run',
        id: 'child',
        execute: async () => 'done',
      },
      contextIn: {
        strategy: 'fresh',
      },
      contextOut: {
        strategy: 'summary',
        model: 'claude-3-haiku',
      },
    };

    await executeSpawn(step, '', new ContextImpl(), simpleExecute, mockCallModel);
    expect(usedModel).toBe('claude-3-haiku');
  });

  it('throws spawn_summary_failed on failure with childOutput', async () => {
    const mockCallModel = async (): Promise<LLMResponse> => {
      throw new Error('LLM unavailable');
    };

    const step: StepSpawn<string, string> = {
      kind: 'spawn',
      id: 'fail-test',
      child: {
        kind: 'run',
        id: 'child',
        execute: async () => 'child-output-value',
      },
      contextIn: {
        strategy: 'fresh',
      },
      contextOut: {
        strategy: 'summary',
      },
    };

    try {
      await executeSpawn(step, '', new ContextImpl(), simpleExecute, mockCallModel);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isOrchidError(e));
      const oe = e.orchidError;
      assert(oe.kind === 'spawn_summary_failed');
      expect(oe.childOutput).toBe('child-output-value');
      expect(oe.summaryCause.message).toBe('LLM unavailable');
    }
  });
});

describe('executeSpawn - schema contextOut', () => {
  it('parses child output against schema', async () => {
    const schema = z.object({
      name: z.string(),
      score: z.number(),
    });
    const step: StepSpawn<string, z.infer<typeof schema>> = {
      kind: 'spawn',
      id: 'test',
      child: {
        kind: 'run',
        id: 'child',
        execute: async () => ({
          name: 'test',
          score: 95,
        }),
      },
      contextIn: {
        strategy: 'fresh',
      },
      contextOut: {
        strategy: 'schema',
        schema,
      },
    };

    const result = await executeSpawn(step, '', new ContextImpl(), simpleExecute);
    expect(result).toEqual({
      name: 'test',
      score: 95,
    });
  });

  it('throws llm_parse_error on schema mismatch', async () => {
    const schema = z.object({
      name: z.string(),
    });
    const step: StepSpawn<string, unknown> = {
      kind: 'spawn',
      id: 'parse-fail',
      child: {
        kind: 'run',
        id: 'child',
        execute: async () => ({
          wrong: 'field',
        }),
      },
      contextIn: {
        strategy: 'fresh',
      },
      contextOut: {
        strategy: 'schema',
        schema,
      },
    };

    try {
      await executeSpawn(step, '', new ContextImpl(), simpleExecute);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isOrchidError(e));
      expect(e.orchidError.kind).toBe('llm_parse_error');
    }
  });
});
