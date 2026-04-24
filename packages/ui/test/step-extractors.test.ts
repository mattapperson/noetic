/**
 * Tests for step data extractors plugin system
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  clearStepDataExtractors,
  getRegisteredStepKinds,
  getStepDataExtractor,
  hasStepDataExtractor,
  registerBuiltinExtractors,
  registerStepDataExtractor,
  resetBuiltinsGuard,
  unregisterStepDataExtractor,
} from '../src/runtime/step-extractors';
import type { TokenUsage } from '../src/runtime/types';

const ZERO_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  total: 0,
};

describe('Step Data Extractors', () => {
  beforeEach(() => {
    registerBuiltinExtractors();
  });

  afterEach(() => {
    clearStepDataExtractors();
    resetBuiltinsGuard();
  });

  describe('built-in extractors', () => {
    it('has llm extractor registered', () => {
      expect(hasStepDataExtractor('llm')).toBe(true);
    });

    it('has tool extractor registered', () => {
      expect(hasStepDataExtractor('tool')).toBe(true);
    });

    it('has fork extractor registered', () => {
      expect(hasStepDataExtractor('fork')).toBe(true);
    });

    it('has loop extractor registered', () => {
      expect(hasStepDataExtractor('loop')).toBe(true);
    });

    it('has spawn extractor registered', () => {
      expect(hasStepDataExtractor('spawn')).toBe(true);
    });

    it('has branch extractor registered', () => {
      expect(hasStepDataExtractor('branch')).toBe(true);
    });

    it('has run extractor registered', () => {
      expect(hasStepDataExtractor('run')).toBe(true);
    });

    it('has provide extractor registered', () => {
      expect(hasStepDataExtractor('provide')).toBe(true);
    });
  });

  describe('llm extractor', () => {
    it('extracts model, messages, toolCalls, tokenUsage, cost', () => {
      const extractor = getStepDataExtractor('llm');
      const tokens: TokenUsage = {
        input: 100,
        output: 50,
        total: 150,
      };
      const result = extractor(
        {
          model: 'gpt-4',
          messages: [
            {
              role: 'user',
            },
          ],
          toolCalls: [],
        },
        tokens,
        0.01,
      );

      expect(result.model).toBe('gpt-4');
      expect(result.toolCalls).toEqual([]);
      expect(result.tokenUsage).toBe(tokens);
      expect(result.cost).toBe(0.01);
    });

    it('includes systemPrompt when present', () => {
      const extractor = getStepDataExtractor('llm');
      const result = extractor(
        {
          model: 'gpt-4',
          systemPrompt: 'Be helpful',
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.systemPrompt).toBe('Be helpful');
    });

    it('defaults model to unknown when missing', () => {
      const extractor = getStepDataExtractor('llm');
      const result = extractor({}, ZERO_TOKENS, 0);
      expect(result.model).toBe('unknown');
    });

    it('populates payloadMessages from messages attribute', () => {
      const extractor = getStepDataExtractor('llm');
      const allItems = [
        {
          role: 'user',
          content: 'hi',
        },
        {
          role: 'assistant',
          content: 'hello',
        },
      ];
      const result = extractor(
        {
          model: 'gpt-4',
          messages: allItems,
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.payloadMessages).toEqual(allItems);
    });

    it('uses responseItems for messages when available', () => {
      const extractor = getStepDataExtractor('llm');
      const allItems = [
        {
          role: 'user',
          content: 'hi',
        },
        {
          role: 'assistant',
          content: 'hello',
        },
      ];
      const responseItems = [
        {
          role: 'assistant',
          content: 'hello',
        },
      ];
      const result = extractor(
        {
          model: 'gpt-4',
          messages: allItems,
          responseItems,
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.messages).toEqual(responseItems);
      expect(result.payloadMessages).toEqual(allItems);
    });

    it('falls back messages to allItems when responseItems is empty', () => {
      const extractor = getStepDataExtractor('llm');
      const allItems = [
        {
          role: 'user',
          content: 'hi',
        },
      ];
      const result = extractor(
        {
          model: 'gpt-4',
          messages: allItems,
          responseItems: [],
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.messages).toEqual(allItems);
    });

    it('parses JSON-serialized messages attribute', () => {
      const extractor = getStepDataExtractor('llm');
      const allItems = [
        {
          role: 'user',
          content: 'hi',
        },
        {
          role: 'assistant',
          content: 'hello',
        },
      ];
      const result = extractor(
        {
          model: 'gpt-4',
          messages: JSON.stringify(allItems),
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.payloadMessages).toEqual(allItems);
    });

    it('parses JSON-serialized responseItems attribute', () => {
      const extractor = getStepDataExtractor('llm');
      const responseItems = [
        {
          role: 'assistant',
          content: 'hello',
        },
      ];
      const allItems = [
        {
          role: 'user',
          content: 'hi',
        },
        ...responseItems,
      ];
      const result = extractor(
        {
          model: 'gpt-4',
          messages: JSON.stringify(allItems),
          responseItems: JSON.stringify(responseItems),
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.messages).toEqual(responseItems);
      expect(result.payloadMessages).toEqual(allItems);
    });

    it('parses JSON-serialized toolCalls attribute', () => {
      const extractor = getStepDataExtractor('llm');
      const toolCalls = [
        {
          name: 'search',
          arguments: {
            q: 'test',
          },
        },
      ];
      const result = extractor(
        {
          model: 'gpt-4',
          toolCalls: JSON.stringify(toolCalls),
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.toolCalls).toEqual(toolCalls);
    });

    it('handles invalid JSON strings gracefully', () => {
      const extractor = getStepDataExtractor('llm');
      const result = extractor(
        {
          model: 'gpt-4',
          messages: 'not-json',
          responseItems: '{bad',
          toolCalls: 'nope',
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.payloadMessages).toEqual([]);
      expect(result.messages).toEqual([]);
      expect(result.toolCalls).toEqual([]);
    });

    it('handles non-array JSON values gracefully', () => {
      const extractor = getStepDataExtractor('llm');
      const result = extractor(
        {
          model: 'gpt-4',
          messages: JSON.stringify({
            not: 'array',
          }),
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.payloadMessages).toEqual([]);
    });

    it('defaults payloadMessages to empty array when missing', () => {
      const extractor = getStepDataExtractor('llm');
      const result = extractor(
        {
          model: 'gpt-4',
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.payloadMessages).toEqual([]);
    });
  });

  describe('tool extractor', () => {
    it('extracts toolName, arguments, result', () => {
      const extractor = getStepDataExtractor('tool');
      const result = extractor(
        {
          toolName: 'search',
          toolArguments: {
            q: 'test',
          },
          toolResult: 42,
        },
        ZERO_TOKENS,
        0.005,
      );

      expect(result.toolName).toBe('search');
      expect(result.arguments).toEqual({
        q: 'test',
      });
      expect(result.result).toBe(42);
      expect(result.cost).toBe(0.005);
    });
  });

  describe('fork extractor', () => {
    it('extracts mode and pathCount', () => {
      const extractor = getStepDataExtractor('fork');
      const result = extractor(
        {
          forkMode: 'all',
          forkPathCount: 3,
        },
        ZERO_TOKENS,
        0,
      );

      expect(result.mode).toBe('all');
      expect(result.pathCount).toBe(3);
    });

    it('includes winnerPath when present', () => {
      const extractor = getStepDataExtractor('fork');
      const result = extractor(
        {
          forkMode: 'race',
          forkPathCount: 2,
          winnerPath: 1,
        },
        ZERO_TOKENS,
        0,
      );

      expect(result.winnerPath).toBe(1);
    });
  });

  describe('loop extractor', () => {
    it('extracts iteration, totalIterations, maxIterations, tokenUsage, cost', () => {
      const extractor = getStepDataExtractor('loop');
      const tokens: TokenUsage = {
        input: 50,
        output: 25,
        total: 75,
      };
      const result = extractor(
        {
          currentIteration: 3,
          totalIterations: 5,
          maxIterations: 10,
        },
        tokens,
        0.02,
      );

      expect(result.iteration).toBe(3);
      expect(result.totalIterations).toBe(5);
      expect(result.maxIterations).toBe(10);
      expect(result.tokenUsage).toBe(tokens);
      expect(result.cost).toBe(0.02);
    });

    it('defaults iteration fields to 0 when missing', () => {
      const extractor = getStepDataExtractor('loop');
      const result = extractor({}, ZERO_TOKENS, 0);

      expect(result.iteration).toBe(0);
      expect(result.totalIterations).toBe(0);
      expect(result.maxIterations).toBe(0);
    });
  });

  describe('spawn extractor', () => {
    it('extracts childStepId, childStepKind, tokenUsage, cost', () => {
      const extractor = getStepDataExtractor('spawn');
      const tokens: TokenUsage = {
        input: 20,
        output: 10,
        total: 30,
      };
      const result = extractor(
        {
          spawnChildId: 'child-1',
          spawnChildKind: 'llm',
        },
        tokens,
        0.005,
      );

      expect(result.childStepId).toBe('child-1');
      expect(result.childStepKind).toBe('llm');
      expect(result.tokenUsage).toBe(tokens);
      expect(result.cost).toBe(0.005);
    });

    it('defaults childStepId to unknown and childStepKind to run', () => {
      const extractor = getStepDataExtractor('spawn');
      const result = extractor({}, ZERO_TOKENS, 0);

      expect(result.childStepId).toBe('unknown');
      expect(result.childStepKind).toBe('run');
    });
  });

  describe('branch extractor', () => {
    it('extracts condition, selectedPath, tokenUsage, cost', () => {
      const extractor = getStepDataExtractor('branch');
      const tokens: TokenUsage = {
        input: 10,
        output: 5,
        total: 15,
      };
      const result = extractor(
        {
          condition: 'x > 0',
          selectedPath: 1,
        },
        tokens,
        0.001,
      );

      expect(result.condition).toBe('x > 0');
      expect(result.selectedPath).toBe(1);
      expect(result.tokenUsage).toBe(tokens);
      expect(result.cost).toBe(0.001);
    });

    it('does not include branchType field', () => {
      const extractor = getStepDataExtractor('branch');
      const result = extractor(
        {
          branchType: 'dynamic',
        },
        ZERO_TOKENS,
        0,
      );

      expect(result.branchType).toBeUndefined();
    });

    it('returns undefined for condition and selectedPath when missing', () => {
      const extractor = getStepDataExtractor('branch');
      const result = extractor({}, ZERO_TOKENS, 0);

      expect(result.condition).toBeUndefined();
      expect(result.selectedPath).toBeUndefined();
    });
  });

  describe('registry operations', () => {
    it('registerStepDataExtractor adds a custom extractor', () => {
      registerStepDataExtractor('custom', (_attrs, tokens, cost) => ({
        custom: true,
        tokenUsage: tokens,
        cost,
      }));

      expect(hasStepDataExtractor('custom')).toBe(true);
      const extractor = getStepDataExtractor('custom');
      const result = extractor({}, ZERO_TOKENS, 0);
      expect(result.custom).toBe(true);

      // Cleanup
      unregisterStepDataExtractor('custom');
    });

    it('unregisterStepDataExtractor removes an extractor', () => {
      registerStepDataExtractor('temp', () => ({}));
      expect(hasStepDataExtractor('temp')).toBe(true);

      const removed = unregisterStepDataExtractor('temp');
      expect(removed).toBe(true);
      expect(hasStepDataExtractor('temp')).toBe(false);
    });

    it('unregisterStepDataExtractor returns false for non-existent', () => {
      const removed = unregisterStepDataExtractor('nonexistent');
      expect(removed).toBe(false);
    });

    it('getRegisteredStepKinds returns all registered kinds', () => {
      const kinds = getRegisteredStepKinds();
      expect(kinds).toContain('llm');
      expect(kinds).toContain('tool');
      expect(kinds).toContain('fork');
      expect(kinds).toContain('loop');
      expect(kinds).toContain('spawn');
      expect(kinds).toContain('branch');
      expect(kinds).toContain('run');
      expect(kinds).toContain('provide');
    });

    it('clearStepDataExtractors removes all extractors', () => {
      clearStepDataExtractors();
      expect(getRegisteredStepKinds()).toHaveLength(0);
      expect(hasStepDataExtractor('llm')).toBe(false);
    });

    it('getStepDataExtractor returns generic fallback for unknown kind', () => {
      const extractor = getStepDataExtractor('unknown-kind');
      const result = extractor(
        {
          stepDescription: 'test desc',
        },
        ZERO_TOKENS,
        0.1,
      );
      expect(result.tokenUsage).toBe(ZERO_TOKENS);
      expect(result.cost).toBe(0.1);
      expect(result.description).toBe('test desc');
    });

    it('generic fallback omits description when not present', () => {
      const extractor = getStepDataExtractor('no-such-kind');
      const result = extractor({}, ZERO_TOKENS, 0);
      expect(result.description).toBeUndefined();
    });

    it('overwriting an existing extractor replaces it', () => {
      registerStepDataExtractor('overwrite-test', () => ({
        version: 1,
      }));
      registerStepDataExtractor('overwrite-test', () => ({
        version: 2,
      }));

      const extractor = getStepDataExtractor('overwrite-test');
      const result = extractor({}, ZERO_TOKENS, 0);
      expect(result.version).toBe(2);

      unregisterStepDataExtractor('overwrite-test');
    });
  });

  describe('error cases', () => {
    it('throws when kind is empty string', () => {
      expect(() => registerStepDataExtractor('', () => ({}))).toThrow(
        'Step kind must be a non-empty string',
      );
    });

    it('throws when extractor is not a function', () => {
      // Call the function at the JS level with a non-function value
      // The runtime guard checks typeof extractor !== 'function'
      const call = Function.prototype.bind.call(
        registerStepDataExtractor,
        null,
        'bad',
        'not-a-function',
      );
      expect(call).toThrow('Extractor must be a function');
    });
  });
});
