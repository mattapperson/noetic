import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextMemory } from '@noetic-tools/memory';
import type {
  Context,
  SettleResult,
  StepForkAll,
  StepForkRace,
  StepForkSettle,
} from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { executeFork } from '../../src/interpreter/execute-control';
import { ChannelStore } from '../../src/runtime/channel-store';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockHarness, simpleExecute } from '../_helpers';

const _StateSchema = z.record(z.string(), z.unknown());

describe('executeFork', () => {
  describe('all mode', () => {
    it('executes all paths and merges results', async () => {
      const step: StepForkAll<ContextMemory, number, number> = {
        kind: 'fork',
        id: 'all-test',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async (i: number) => i * 2,
          },
          {
            kind: 'run',
            id: 'b',
            execute: async (i: number) => i * 3,
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, 5, ctx, simpleExecute);
      expect(result).toBe(25); // 10 + 15
    });

    it('throws fork_partial when any path fails', async () => {
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'fail-test',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'ok',
            execute: async () => 'success',
          },
          {
            kind: 'run',
            id: 'fail',
            execute: async () => {
              throw new Error('boom');
            },
          },
        ],
        merge: (results) => results.join(','),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await executeFork(step, '', ctx, simpleExecute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'fork_partial');
        expect(oe.succeeded).toHaveLength(1);
        expect(oe.succeeded[0].stepId).toBe('ok');
        expect(oe.failed).toHaveLength(1);
      }
    });

    it('state is isolated between paths', async () => {
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'iso-test',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            // Fork gives child contexts; state is writable via Context interface
            execute: async (_: string, ctx: Context) => {
              ctx.state = {
                modified: 'by-a',
              };
              return 'a';
            },
          },
          {
            kind: 'run',
            id: 'b',
            execute: async (_: string, ctx: Context) => {
              // Should NOT see a's mutation
              return JSON.stringify(ctx.state);
            },
          },
        ],
        merge: (results) => results.join('|'),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        state: {
          original: true,
        },
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      // b should see the original state, not a's mutation
      const bResult = result.split('|')[1];
      const bState = _StateSchema.parse(JSON.parse(bResult));
      expect(bState.modified).toBeUndefined();
      expect(bState.original).toBe(true);
      // Parent state should also be unchanged
      const parentState = _StateSchema.parse(ctx.state);
      expect(parentState.original).toBe(true);
    });

    it('respects concurrency limit', async () => {
      let maxConcurrent = 0;
      let current = 0;
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'conc-test',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async () => {
              current++;
              maxConcurrent = Math.max(maxConcurrent, current);
              await new Promise((r) => setTimeout(r, 50));
              current--;
              return 'a';
            },
          },
          {
            kind: 'run',
            id: 'b',
            execute: async () => {
              current++;
              maxConcurrent = Math.max(maxConcurrent, current);
              await new Promise((r) => setTimeout(r, 50));
              current--;
              return 'b';
            },
          },
          {
            kind: 'run',
            id: 'c',
            execute: async () => {
              current++;
              maxConcurrent = Math.max(maxConcurrent, current);
              await new Promise((r) => setTimeout(r, 50));
              current--;
              return 'c';
            },
          },
        ],
        merge: (r) => r.join(','),
        concurrency: 2,
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      await executeFork(step, '', ctx, simpleExecute);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('concurrency: 1 forces serial execution', async () => {
      let maxConcurrent = 0;
      let current = 0;
      const makeTimedPath = (id: string) => ({
        kind: 'run' as const,
        id,
        execute: async () => {
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          await new Promise((r) => setTimeout(r, 5));
          current--;
          return id;
        },
      });
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'serial-test',
        mode: 'all',
        paths: () => [
          makeTimedPath('a'),
          makeTimedPath('b'),
          makeTimedPath('c'),
        ],
        merge: (r) => r.join(','),
        concurrency: 1,
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(maxConcurrent).toBe(1);
      expect(result).toBe('a,b,c');
    });

    it('paths() receives input and context', async () => {
      let capturedInput: string | undefined;
      let capturedCtx: Context | undefined;
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'args-test',
        mode: 'all',
        paths: (input, ctx) => {
          capturedInput = input;
          capturedCtx = ctx;
          return [
            {
              kind: 'run',
              id: 'a',
              execute: async () => 'done',
            },
          ];
        },
        merge: (r) => r.join(','),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      await executeFork(step, 'test-input', ctx, simpleExecute);
      expect(capturedInput).toBe('test-input');
      expect(capturedCtx).toBe(ctx);
    });

    it('merge() receives context as second arg', async () => {
      let capturedCtx: Context | undefined;
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'merge-ctx-test',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async () => 'done',
          },
        ],
        merge: (results, ctx) => {
          capturedCtx = ctx;
          return results.join(',');
        },
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      await executeFork(step, '', ctx, simpleExecute);
      expect(capturedCtx).toBe(ctx);
    });

    it('handles empty paths', async () => {
      const step: StepForkAll<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'empty-all',
        mode: 'all',
        paths: () => [],
        merge: (results) => `got ${results.length}`,
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('got 0');
    });
  });

  describe('race mode', () => {
    it('returns first completed result', async () => {
      const step: StepForkRace<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'race-test',
        mode: 'race',
        paths: () => [
          {
            kind: 'run',
            id: 'slow',
            execute: async () => {
              await new Promise((r) => setTimeout(r, 200));
              return 'slow';
            },
          },
          {
            kind: 'run',
            id: 'fast',
            execute: async () => {
              await new Promise((r) => setTimeout(r, 10));
              return 'fast';
            },
          },
        ],
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('fast');
    });

    it('winner state replaces parent state', async () => {
      const step: StepForkRace<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'state-test',
        mode: 'race',
        paths: () => [
          {
            kind: 'run',
            id: 'winner',
            // Fork gives child contexts; state is writable via Context interface
            execute: async (_: string, ctx: Context) => {
              ctx.state = {
                winner: true,
              };
              return 'won';
            },
          },
          {
            kind: 'run',
            id: 'loser',
            execute: async () => {
              await new Promise((r) => setTimeout(r, 200));
              return 'lost';
            },
          },
        ],
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        state: {
          original: true,
        },
      });
      await executeFork(step, '', ctx, simpleExecute);
      const finalState = _StateSchema.parse(ctx.state);
      expect(finalState.winner).toBe(true);
    });

    it('aborts loser contexts after winner resolves', async () => {
      const childContexts: Context[] = [];
      const step: StepForkRace<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'abort-test',
        mode: 'race',
        paths: () => [
          {
            kind: 'run',
            id: 'fast',
            // Fork gives child contexts; captured to check abort state
            execute: async (_: string, ctx: Context) => {
              childContexts.push(ctx);
              return 'winner';
            },
          },
          {
            kind: 'run',
            id: 'slow',
            execute: async (_: string, ctx: Context) => {
              childContexts.push(ctx);
              await new Promise((r) => setTimeout(r, 200));
              return 'loser';
            },
          },
        ],
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('winner');
      // Allow time for abort to propagate
      await new Promise((r) => setTimeout(r, 50));
      // The losing context should have been aborted
      const loserCtx = childContexts.find((c) => c.aborted);
      expect(loserCtx).toBeDefined();
    });

    it('respects concurrency limit in race mode', async () => {
      let maxConcurrent = 0;
      let current = 0;
      const step: StepForkRace<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'race-conc-test',
        mode: 'race',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async () => {
              current++;
              maxConcurrent = Math.max(maxConcurrent, current);
              await new Promise((r) => setTimeout(r, 50));
              current--;
              return 'a';
            },
          },
          {
            kind: 'run',
            id: 'b',
            execute: async () => {
              current++;
              maxConcurrent = Math.max(maxConcurrent, current);
              await new Promise((r) => setTimeout(r, 50));
              current--;
              return 'b';
            },
          },
          {
            kind: 'run',
            id: 'c',
            execute: async () => {
              current++;
              maxConcurrent = Math.max(maxConcurrent, current);
              await new Promise((r) => setTimeout(r, 50));
              current--;
              return 'c';
            },
          },
        ],
        concurrency: 2,
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      await executeFork(step, '', ctx, simpleExecute);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('all fail throws fork_partial', async () => {
      const step: StepForkRace<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'all-fail',
        mode: 'race',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async () => {
              throw new Error('fail a');
            },
          },
          {
            kind: 'run',
            id: 'b',
            execute: async () => {
              throw new Error('fail b');
            },
          },
        ],
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await executeFork(step, '', ctx, simpleExecute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'fork_partial');
        expect(oe.succeeded).toHaveLength(0);
        expect(oe.failed).toHaveLength(2);
      }
    });

    it('throws fork_partial on empty paths', async () => {
      const step: StepForkRace<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'empty-race',
        mode: 'race',
        paths: () => [],
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await executeFork(step, '', ctx, simpleExecute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('fork_partial');
      }
    });
  });

  describe('settle mode', () => {
    it('waits for all and never throws', async () => {
      const step: StepForkSettle<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'settle-test',
        mode: 'settle',
        paths: () => [
          {
            kind: 'run',
            id: 'ok',
            execute: async () => 'success',
          },
          {
            kind: 'run',
            id: 'fail',
            execute: async () => {
              throw new Error('boom');
            },
          },
        ],
        merge: (results: SettleResult<string>[]) => {
          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          const rejected = results.filter((r) => r.status === 'rejected');
          return `${fulfilled.length} ok, ${rejected.length} failed`;
        },
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('1 ok, 1 failed');
    });

    it('settle result has correct shape', async () => {
      let capturedResults: SettleResult<string>[] = [];
      const step: StepForkSettle<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'shape-test',
        mode: 'settle',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async () => 'value-a',
          },
          {
            kind: 'run',
            id: 'b',
            execute: async () => {
              throw new Error('err-b');
            },
          },
        ],
        merge: (results: SettleResult<string>[]) => {
          capturedResults = results;
          return 'done';
        },
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      await executeFork(step, '', ctx, simpleExecute);

      expect(capturedResults).toHaveLength(2);
      const fulfilled = capturedResults.find((r) => r.status === 'fulfilled')!;
      expect(fulfilled.stepId).toBe('a');
      expect(fulfilled.value).toBe('value-a');

      const rejected = capturedResults.find((r) => r.status === 'rejected')!;
      expect(rejected.stepId).toBe('b');
      expect(rejected.error!.kind).toBe('step_failed');
    });

    it('handles empty paths', async () => {
      const step: StepForkSettle<ContextMemory, string, string> = {
        kind: 'fork',
        id: 'empty-settle',
        mode: 'settle',
        paths: () => [],
        merge: (results: SettleResult<string>[]) => `got ${results.length}`,
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const result = await executeFork(step, '', ctx, simpleExecute);
      expect(result).toBe('got 0');
    });
  });

  describe('channel store inheritance', () => {
    it('child contexts inherit channelStore so siblings can communicate', async () => {
      const ch = channel<number>('fork-share', {
        schema: z.number(),
        mode: 'queue',
      });
      const channelStore = new ChannelStore();

      let senderError: unknown = null;
      let received: number | null | undefined;

      const step: StepForkAll<ContextMemory, void, void> = {
        kind: 'fork',
        id: 'channel-share',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'sender',
            execute: async (_input, c) => {
              try {
                c.send(ch, 7);
              } catch (e) {
                senderError = e;
              }
            },
          },
          {
            kind: 'run',
            id: 'receiver',
            execute: async (_input, c) => {
              await new Promise((r) => setTimeout(r, 10));
              received = c.tryRecv(ch);
            },
          },
        ],
        merge: () => undefined,
      };

      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        channelStore,
      });
      await executeFork(step, undefined, ctx, simpleExecute);
      expect(senderError).toBeNull();
      assert(received !== undefined);
      expect(received).toBe(7);
    });
  });
});
