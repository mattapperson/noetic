import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, ContextLayer, LayerStateStore } from '@noetic-tools/context';
import { createLayerStateStore, Slot } from '@noetic-tools/context';
import type {
  Context,
  SettleResult,
  StepForkAll,
  StepForkRace,
  StepForkSettle,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { loop } from '../../src/builders/loop-builder';
import { execute } from '../../src/interpreter/execute';
import { executeFork } from '../../src/interpreter/execute-control';
import { ChannelStore } from '../../src/runtime/channel-store';
import { ContextImpl } from '../../src/runtime/context-impl';
import { until } from '../../src/until/predicates';
import { makeMessage, makeMockHarness, simpleExecute } from '../_helpers';

const _StateSchema = z.record(z.string(), z.unknown());

describe('executeFork', () => {
  describe('all mode', () => {
    it('executes all paths and merges results', async () => {
      const step: StepForkAll<ContextData, number, number> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkAll<ContextData, string, string> = {
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
      const step: StepForkRace<ContextData, string, string> = {
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
      const step: StepForkRace<ContextData, string, string> = {
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
      const step: StepForkRace<ContextData, string, string> = {
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
      const step: StepForkRace<ContextData, string, string> = {
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
      const step: StepForkRace<ContextData, string, string> = {
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
      const step: StepForkRace<ContextData, string, string> = {
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
      const step: StepForkSettle<ContextData, string, string> = {
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
      const step: StepForkSettle<ContextData, string, string> = {
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
      const step: StepForkSettle<ContextData, string, string> = {
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

      const step: StepForkAll<ContextData, void, void> = {
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

  describe('context-layer child boundary', () => {
    interface ArtifactState {
      files: string[];
    }

    function makeArtifactLayer(overrides?: Partial<ContextLayer['hooks']>): ContextLayer {
      return {
        id: 'artifacts',
        name: 'artifacts',
        slot: Slot.WORKING_MEMORY,
        scope: 'execution',
        hooks: {
          onSpawn: async ({ parentState }) => ({
            childState: structuredClone(parentState),
          }),
          onReturn: async ({ parentState, childState }) => {
            const parent = frameworkCast<ArtifactState>(parentState);
            const child = frameworkCast<ArtifactState>(childState);
            return {
              parentState: {
                files: [
                  ...new Set([
                    ...parent.files,
                    ...child.files,
                  ]),
                ],
              },
            };
          },
          ...overrides,
        },
      };
    }

    /** A path that records one artifact into its own (child) layer state. */
    function makeRecordingPath(id: string, file: string, store: LayerStateStore) {
      return {
        kind: 'run' as const,
        id,
        execute: async (_input: string, c: Context<ContextData>): Promise<string> => {
          const seeded = frameworkCast<ArtifactState | undefined>(store.get(c.id, 'artifacts'));
          store.set(c.id, 'artifacts', {
            files: [
              ...(seeded?.files ?? []),
              file,
            ],
          });
          return file;
        },
      };
    }

    it('seeds each path via onSpawn and merges every path back via onReturn', async () => {
      const store = createLayerStateStore();
      const layer = makeArtifactLayer();
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        layers: [
          layer,
        ],
      });
      store.set(ctx.id, 'artifacts', {
        files: [
          'coordinator.ts',
        ],
      });

      const step: StepForkAll<ContextData, string, string> = {
        kind: 'fork',
        id: 'fan-out',
        mode: 'all',
        paths: () => [
          makeRecordingPath('worker-a', 'a.ts', store),
          makeRecordingPath('worker-b', 'b.ts', store),
        ],
        merge: (results) => results.join(','),
      };

      const merged = await executeFork(step, '', ctx, simpleExecute, {
        layerStore: store,
      });
      expect(merged).toBe('a.ts,b.ts');

      // Both workers' artifacts reached the parent, and each worker started
      // from a clone of the parent's state (onSpawn).
      const parentState = frameworkCast<ArtifactState>(store.get(ctx.id, 'artifacts'));
      expect(
        [
          ...parentState.files,
        ].sort(),
      ).toEqual([
        'a.ts',
        'b.ts',
        'coordinator.ts',
      ]);
    });

    it('discards a failed path and still merges its successful siblings (settle)', async () => {
      const store = createLayerStateStore();
      const layer = makeArtifactLayer();
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        layers: [
          layer,
        ],
      });
      store.set(ctx.id, 'artifacts', {
        files: [],
      });

      const step: StepForkSettle<ContextData, string, string> = {
        kind: 'fork',
        id: 'partial-fan-out',
        mode: 'settle',
        paths: () => [
          makeRecordingPath('ok', 'ok.ts', store),
          {
            kind: 'run',
            id: 'boom',
            execute: async (_input: string, c: Context<ContextData>): Promise<string> => {
              store.set(c.id, 'artifacts', {
                files: [
                  'never.ts',
                ],
              });
              throw new Error('worker failed');
            },
          },
        ],
        merge: (results: SettleResult<string>[]) =>
          results.filter((r) => r.status === 'fulfilled').length.toString(),
      };

      const fulfilled = await executeFork(step, '', ctx, simpleExecute, {
        layerStore: store,
      });
      expect(fulfilled).toBe('1');

      const parentState = frameworkCast<ArtifactState>(store.get(ctx.id, 'artifacts'));
      expect(parentState.files).toEqual([
        'ok.ts',
      ]);
    });

    it('cleans up each child layer state after its path finishes', async () => {
      const store = createLayerStateStore();
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        layers: [
          makeArtifactLayer(),
        ],
      });
      store.set(ctx.id, 'artifacts', {
        files: [],
      });

      const childIds: string[] = [];
      const step: StepForkAll<ContextData, string, string> = {
        kind: 'fork',
        id: 'cleanup',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'p',
            execute: async (_input: string, c: Context<ContextData>): Promise<string> => {
              childIds.push(c.id);
              store.set(c.id, 'artifacts', {
                files: [
                  'p.ts',
                ],
              });
              return 'p';
            },
          },
        ],
        merge: (results) => results.join(''),
      };

      await executeFork(step, '', ctx, simpleExecute, {
        layerStore: store,
      });
      expect(childIds).toHaveLength(1);
      expect(store.get(childIds[0], 'artifacts')).toBeUndefined();
    });

    it('forked children inherit the parent layers and tool pool', async () => {
      const layer = makeArtifactLayer();
      const tool = {
        name: 'noop',
        description: 'noop',
        input: z.object({}),
        output: z.string(),
        execute: async () => 'ok',
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        layers: [
          layer,
        ],
        unifiedTools: [
          tool,
        ],
      });

      let childLayerIds: string[] = [];
      let childToolNames: string[] = [];
      const step: StepForkAll<ContextData, string, string> = {
        kind: 'fork',
        id: 'inherit',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'p',
            execute: async (_input: string, c: Context<ContextData>): Promise<string> => {
              childLayerIds = (c.layers ?? []).map((l) => l.id);
              childToolNames = (c.unifiedTools ?? []).map((t) => t.name);
              return 'p';
            },
          },
        ],
        merge: (results) => results.join(''),
      };

      await executeFork(step, '', ctx, simpleExecute, {
        layerStore: createLayerStateStore(),
      });
      expect(childLayerIds).toEqual([
        'artifacts',
      ]);
      expect(childToolNames).toEqual([
        'noop',
      ]);
    });

    it('does not append onSpawn items — a fork child already has the parent log', async () => {
      const store = createLayerStateStore();
      const layer = makeArtifactLayer({
        onSpawn: async ({ parentState }) => ({
          childState: structuredClone(parentState),
          items: [
            makeMessage('user', 'seeded by layer', 'seed-1'),
          ],
        }),
      });
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
        layers: [
          layer,
        ],
      });
      ctx.itemLog.append(makeMessage('user', 'parent turn', 'p1'));
      store.set(ctx.id, 'artifacts', {
        files: [],
      });

      let childItemCount = -1;
      const step: StepForkAll<ContextData, string, string> = {
        kind: 'fork',
        id: 'no-double-seed',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'p',
            execute: async (_input: string, c: Context<ContextData>): Promise<string> => {
              childItemCount = c.itemLog.items.length;
              return 'p';
            },
          },
        ],
        merge: (results) => results.join(''),
      };

      await executeFork(step, '', ctx, simpleExecute, {
        layerStore: store,
      });
      expect(childItemCount).toBe(1);
    });

    it('runs no boundary at all when the parent has no layers', async () => {
      const store = createLayerStateStore();
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'no-layers',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async (i: number) => i + 1,
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      expect(
        await executeFork(step, 1, ctx, simpleExecute, {
          layerStore: store,
        }),
      ).toBe(2);
    });
  });

  describe('all mode fail-fast cancellation (real execute)', () => {
    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    it("first failure aborts in-flight siblings: the sibling's second step never runs", async () => {
      let siblingSecondStepRan = 0;
      const slowSibling = loop<ContextData, number, number>({
        id: 'slow-sibling',
        steps: [
          {
            kind: 'run',
            id: 'slow-1',
            execute: async (i: number) => {
              await sleep(100);
              return i;
            },
          },
          {
            kind: 'run',
            id: 'slow-2',
            execute: async (i: number) => {
              siblingSecondStepRan++;
              return i;
            },
          },
        ],
        until: until.maxSteps(1),
      });
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'fail-fast-fork',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'fail-fast',
            execute: async () => {
              throw new Error('instant boom');
            },
          },
          slowSibling,
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await executeFork(step, 1, ctx, execute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'fork_partial');
        expect(oe.succeeded).toHaveLength(0);
        expect(oe.failed).toHaveLength(2);
        const failedKinds = new Map(
          oe.failed.map((f) => [
            f.stepId,
            f.error.kind,
          ]),
        );
        expect(failedKinds.get('fail-fast')).toBe('step_failed');
        // The aborted sibling surfaces as cancelled inside failed[].
        expect(failedKinds.get('slow-sibling')).toBe('cancelled');
      }
      // The abort landed before the sibling's second step could dispatch.
      expect(siblingSecondStepRan).toBe(0);
      expect(ctx.aborted).toBe(false);
    });

    it('concurrency 1: paths queued behind a failure are skipped without executing', async () => {
      const executed: string[] = [];
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'queued-skip-fork',
        mode: 'all',
        concurrency: 1,
        paths: () => [
          {
            kind: 'run',
            id: 'p1',
            execute: async () => {
              executed.push('p1');
              throw new Error('boom');
            },
          },
          {
            kind: 'run',
            id: 'p2',
            execute: async (i: number) => {
              executed.push('p2');
              return i;
            },
          },
          {
            kind: 'run',
            id: 'p3',
            execute: async (i: number) => {
              executed.push('p3');
              return i;
            },
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await executeFork(step, 1, ctx, execute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'fork_partial');
        expect(oe.failed).toHaveLength(3);
        const failedKinds = new Map(
          oe.failed.map((f) => [
            f.stepId,
            f.error.kind,
          ]),
        );
        expect(failedKinds.get('p1')).toBe('step_failed');
        expect(failedKinds.get('p2')).toBe('cancelled');
        expect(failedKinds.get('p3')).toBe('cancelled');
      }
      expect(executed).toEqual([
        'p1',
      ]);
      expect(ctx.itemLog.items).toHaveLength(0);
    });

    it('a path that completed before the failure lands in succeeded', async () => {
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'partial-success-fork',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'quick-success',
            execute: async (i: number) => {
              await sleep(10);
              return i * 2;
            },
          },
          {
            kind: 'run',
            id: 'late-failure',
            execute: async () => {
              await sleep(50);
              throw new Error('late boom');
            },
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      try {
        await executeFork(step, 3, ctx, execute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'fork_partial');
        expect(oe.succeeded).toEqual([
          {
            stepId: 'quick-success',
            value: 6,
          },
        ]);
        expect(oe.failed).toHaveLength(1);
        expect(oe.failed[0].stepId).toBe('late-failure');
        expect(oe.failed[0].error.kind).toBe('step_failed');
      }
    });

    it('parent abort mid-fork surfaces cancelled, not fork_partial', async () => {
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'parent-abort-fork',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'steady',
            execute: async (i: number) => {
              await sleep(50);
              return i;
            },
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      setTimeout(() => {
        ctx.abort('caller cancelled');
      }, 10);
      try {
        await executeFork(step, 1, ctx, execute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'cancelled');
        expect(oe.reason).toBe('caller cancelled');
      }
    });

    it('all-success regression: fail-fast machinery does not disturb a clean fork', async () => {
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'clean-fork',
        mode: 'all',
        concurrency: 2,
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async (i: number) => i + 1,
          },
          {
            kind: 'run',
            id: 'b',
            execute: async (i: number) => i + 2,
          },
          {
            kind: 'run',
            id: 'c',
            execute: async (i: number) => i + 3,
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      expect(await executeFork(step, 10, ctx, execute)).toBe(36);
    });

    it('parent abort cascades into the in-flight path contexts', async () => {
      const seen: Context<ContextData>[] = [];
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'cascade-fork',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'slow-a',
            execute: async (i: number, pathCtx) => {
              seen.push(pathCtx);
              await sleep(50);
              return i;
            },
          },
          {
            kind: 'run',
            id: 'slow-b',
            execute: async (i: number, pathCtx) => {
              seen.push(pathCtx);
              await sleep(50);
              return i;
            },
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });
      setTimeout(() => {
        ctx.abort('caller cancelled');
      }, 10);

      await expect(executeFork(step, 1, ctx, execute)).rejects.toThrow();

      expect(seen).toHaveLength(2);
      for (const pathCtx of seen) {
        expect(pathCtx.aborted).toBe(true);
        expect(pathCtx.abortReason).toBe('caller cancelled');
      }
      // Settled paths leave the parent's cascade registry.
      expect(ctx.children).toHaveLength(0);
    });

    it('detaches path contexts once the fork settles', async () => {
      const step: StepForkAll<ContextData, number, number> = {
        kind: 'fork',
        id: 'detach-fork',
        mode: 'all',
        paths: () => [
          {
            kind: 'run',
            id: 'a',
            execute: async (i: number) => i + 1,
          },
          {
            kind: 'run',
            id: 'b',
            execute: async (i: number) => i + 2,
          },
        ],
        merge: (results) => results.reduce((a, b) => a + b, 0),
      };
      const ctx = new ContextImpl({
        harness: makeMockHarness(),
      });

      expect(await executeFork(step, 1, ctx, execute)).toBe(5);
      expect(ctx.children).toHaveLength(0);
    });
  });
});
