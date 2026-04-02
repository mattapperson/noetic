/**
 * Tests for step data extractors plugin system
 */

import { describe, expect, it } from 'bun:test';
import {
  clearStepDataExtractors,
  getRegisteredStepKinds,
  getStepDataExtractor,
  hasStepDataExtractor,
  registerStepDataExtractor,
  unregisterStepDataExtractor,
} from '../src/runtime/step-extractors';
import type { TokenUsage } from '../src/runtime/types';

const ZERO_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  total: 0,
};

describe('Step Data Extractors', () => {
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
      expect(result.messages).toEqual([
        {
          role: 'user',
        },
      ]);
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
    it('extracts stepCount', () => {
      const extractor = getStepDataExtractor('loop');
      const result = extractor(
        {
          loopStepCount: 5,
        },
        ZERO_TOKENS,
        0,
      );
      expect(result.stepCount).toBe(5);
    });

    it('includes currentIteration and maxIterations when present', () => {
      const extractor = getStepDataExtractor('loop');
      const result = extractor(
        {
          loopStepCount: 3,
          currentIteration: 2,
          maxIterations: 10,
        },
        ZERO_TOKENS,
        0,
      );

      expect(result.currentIteration).toBe(2);
      expect(result.maxIterations).toBe(10);
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

      // Re-register built-ins by re-importing the module side effects
      // Since modules are cached, we need to manually re-register
      registerStepDataExtractor('llm', (attrs, tokens, cost) => ({
        model: attrs.model || 'unknown',
        messages: attrs.messages || [],
        toolCalls: attrs.toolCalls || [],
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('tool', (attrs, tokens, cost) => ({
        toolName: attrs.toolName || 'unknown',
        arguments: attrs.toolArguments,
        result: attrs.toolResult,
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('fork', (attrs, tokens, cost) => ({
        mode: attrs.forkMode || 'race',
        pathCount: attrs.forkPathCount || 0,
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('loop', (attrs, tokens, cost) => ({
        stepCount: attrs.loopStepCount || 0,
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('spawn', (attrs, tokens, cost) => ({
        childId: attrs.spawnChildId || 'unknown',
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('branch', (attrs, tokens, cost) => ({
        branchType: attrs.branchType || 'dynamic',
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('run', (_attrs, tokens, cost) => ({
        tokenUsage: tokens,
        cost,
      }));
      registerStepDataExtractor('provide', (attrs, tokens, cost) => ({
        providerId: attrs.providerId,
        provides: attrs.provides,
        tokenUsage: tokens,
        cost,
      }));
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
