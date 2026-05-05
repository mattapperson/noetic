import { describe, expect, it } from 'bun:test';
import { branch } from '../../src/builders/control-flow-builders';
import { otherwise, semanticRoute, when } from '../../src/conditions';
import { executeBranch } from '../../src/interpreter/execute-control';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { ContextMemory } from '../../src/types/memory';
import { makeMockHarness, mockEmbed, simpleExecute } from '../_helpers';

describe('semantic branch integration', () => {
  it('branch() with semanticRoute routes through executeBranch', async () => {
    const embed = mockEmbed({
      'hello there': [
        1,
        0,
        0,
      ],
      greeting: [
        0.95,
        0.05,
        0,
      ],
    });

    const greetingStep = {
      kind: 'run' as const,
      id: 'greeting-handler',
      execute: async () => 'handled greeting',
    };
    const fallbackStep = {
      kind: 'run' as const,
      id: 'fallback-handler',
      execute: async () => 'handled fallback',
    };

    const step = branch<ContextMemory, string, string>({
      id: 'semantic-branch',
      route: semanticRoute(
        when(async (input: string) => {
          const [inputVec] = await embed([
            input,
          ]);
          const [labelVec] = await embed([
            'greeting',
          ]);
          // Simple dot product check
          let dot = 0;
          for (let i = 0; i < inputVec.length; i++) {
            dot += inputVec[i] * labelVec[i];
          }
          return dot > 0.5;
        }, greetingStep),
        otherwise(fallbackStep),
      ),
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const result = await executeBranch(step, 'hello there', ctx, simpleExecute);
    expect(result).toBe('handled greeting');
  });

  it('async route in branch() works end-to-end', async () => {
    const step = branch<ContextMemory, string, string>({
      id: 'async-branch',
      route: async (input) => {
        // Simulate async operation
        await Promise.resolve();
        if (input === 'match') {
          return {
            kind: 'run' as const,
            id: 'matched',
            execute: async () => 'matched!',
          };
        }
        return null;
      },
    });

    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const matched = await executeBranch(step, 'match', ctx, simpleExecute);
    expect(matched).toBe('matched!');

    const passthrough = await executeBranch(step, 'no-match', ctx, simpleExecute);
    expect(passthrough).toBe('no-match');
  });
});
