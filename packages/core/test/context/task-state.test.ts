import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { TaskState } from '@noetic-tools/context';
import { taskState } from '@noetic-tools/context';
import { makeCtx, makeItemLog, makeScopedStorage } from '../_helpers';

describe('taskState', () => {
  it('has correct id and slot', () => {
    const layer = taskState();
    expect(layer.id).toBe('task-state');
    expect(layer.slot).toBe(110);
    // 'thread' so checkpoints persist across executions within a thread.
    expect(layer.scope).toBe('thread');
  });

  it('init/recall lifecycle', async () => {
    const layer = taskState();
    const result = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'exec-1',
      ctx: makeCtx(),
    });
    expect(result.state).toEqual({
      checkpoints: [],
      files: [],
      data: {},
    });

    const recalled = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state: result.state,
      budget: 500,
    });
    expect(recalled).not.toBeNull();
    assert(typeof recalled !== 'string');
    const msg = recalled!.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert(part.type === 'input_text');
    expect(part.text).toContain('<task_state>');
  });

  it('onSpawn always provides child state', async () => {
    const layer = taskState();
    const parentState = {
      checkpoints: [
        {
          timestamp: 1,
          depth: 0,
        },
      ],
      files: [
        'a.ts',
      ],
      data: {
        key: 'val',
      },
    };
    const result = await layer.hooks.onSpawn!({
      parentState,
      childCtx: makeCtx(),
    });
    expect(result).not.toBeNull();
    expect(result!.childState).toEqual(parentState);
    // Should be a clone
    expect(result!.childState).not.toBe(parentState);
  });

  it('store hook accumulates checkpoints', async () => {
    const layer = taskState();
    const state: TaskState = {
      checkpoints: [],
      files: [],
      data: {},
    };
    const result1 = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state,
    });
    assert(result1 !== undefined);
    const result2 = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: {
        items: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: result1.state,
    });
    assert(result2 !== undefined);
    expect(result2.state.checkpoints).toHaveLength(2);
    expect(result2.state.checkpoints[0]).toHaveProperty('timestamp');
    expect(result2.state.checkpoints[0]).toHaveProperty('depth');
  });

  it('onReturn with conflicting keys: child overwrites parent', async () => {
    const layer = taskState();
    const parentState: TaskState = {
      checkpoints: [],
      files: [],
      data: {
        key: 'parent-value',
      },
    };
    const childState: TaskState = {
      checkpoints: [],
      files: [],
      data: {
        key: 'child-value',
      },
    };
    const result = await layer.hooks.onReturn!({
      childState,
      childLog: makeItemLog(),
      childCtx: makeCtx({
        executionId: 'child-1',
      }),
      parentState,
      result: 'done',
    });
    assert(result !== undefined);
    // { ...parent.data, ...child.data } → child overwrites
    expect(result.parentState.data.key).toBe('child-value');
  });

  it('onReturn merges child artifacts back', async () => {
    const layer = taskState();
    const parentState: TaskState = {
      checkpoints: [
        {
          timestamp: 1,
          depth: 0,
        },
      ],
      files: [
        'a.ts',
      ],
      data: {
        x: 1,
      },
    };
    const childState: TaskState = {
      checkpoints: [
        {
          timestamp: 2,
          depth: 0,
        },
      ],
      files: [
        'b.ts',
      ],
      data: {
        y: 2,
      },
    };
    const result = await layer.hooks.onReturn!({
      childState,
      childLog: makeItemLog(),
      childCtx: makeCtx({
        executionId: 'child-1',
      }),
      parentState,
      result: 'done',
    });
    assert(result !== undefined);
    expect(result.parentState.checkpoints).toHaveLength(2);
    expect(result.parentState.files).toContain('a.ts');
    expect(result.parentState.files).toContain('b.ts');
    expect(result.parentState.data).toEqual({
      x: 1,
      y: 2,
    });
  });

  it('onComplete returns state with outcome and checkpoint', async () => {
    const layer = taskState();
    const state: TaskState = {
      checkpoints: [],
      files: [],
      data: {},
    };
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx: makeCtx(),
      state,
      outcome: 'success',
    });
    assert(result !== undefined);
    expect(result.state.data.__outcome).toBe('success');
    expect(result.state.checkpoints).toHaveLength(1);
    expect(result.state.checkpoints[0]).toHaveProperty('timestamp');
  });

  it('onComplete returns state with failure outcome', async () => {
    const layer = taskState();
    const state: TaskState = {
      checkpoints: [
        {
          timestamp: 1,
          depth: 0,
        },
      ],
      files: [],
      data: {},
    };
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx: makeCtx(),
      state,
      outcome: 'failure',
    });
    assert(result !== undefined);
    expect(result.state.data.__outcome).toBe('failure');
    expect(result.state.checkpoints).toHaveLength(2);
  });

  it('onComplete stamps the completing execution depth, not 0', async () => {
    const layer = taskState();
    const result = await layer.hooks.onComplete!({
      log: makeItemLog(),
      ctx: makeCtx({
        depth: 3,
      }),
      state: {
        checkpoints: [],
        files: [],
        data: {},
      },
      outcome: 'success',
    });
    assert(result !== undefined);
    expect(result.state.checkpoints[0].depth).toBe(3);
  });

  describe('write API (provides)', () => {
    function emptyState(): TaskState {
      return {
        checkpoints: [],
        files: [],
        data: {},
      };
    }

    it('exposes recordArtifact and setTaskData as layer functions', () => {
      const layer = taskState();
      assert(layer.provides !== undefined);
      expect(layer.provides.recordArtifact.kind).toBe('function');
      expect(layer.provides.setTaskData.kind).toBe('function');
    });

    it('recordArtifact appends a file path to state', async () => {
      const layer = taskState();
      const { result, state } = await layer.provides.recordArtifact.execute(
        {
          path: 'src/a.ts',
        },
        emptyState(),
        makeCtx(),
      );
      assert(state !== undefined);
      expect(state.files).toEqual([
        'src/a.ts',
      ]);
      expect(result).toContain('src/a.ts');
    });

    it('recordArtifact is idempotent for an already-recorded path', async () => {
      const layer = taskState();
      const first = await layer.provides.recordArtifact.execute(
        {
          path: 'src/a.ts',
        },
        emptyState(),
        makeCtx(),
      );
      assert(first.state !== undefined);
      const second = await layer.provides.recordArtifact.execute(
        {
          path: 'src/a.ts',
        },
        first.state,
        makeCtx(),
      );
      assert(second.state !== undefined);
      expect(second.state.files).toHaveLength(1);
      expect(second.result).toContain('Already recorded');
    });

    it('recordArtifact rejects an empty path via its input schema', () => {
      const layer = taskState();
      const parsed = layer.provides.recordArtifact.input.safeParse({
        path: '',
      });
      expect(parsed.success).toBe(false);
    });

    it('setTaskData records a structured value under a key', async () => {
      const layer = taskState();
      const { state } = await layer.provides.setTaskData.execute(
        {
          key: 'pr',
          value: {
            url: 'https://example.test/pr/1',
          },
        },
        emptyState(),
        makeCtx(),
      );
      assert(state !== undefined);
      expect(state.data.pr).toEqual({
        url: 'https://example.test/pr/1',
      });
    });

    it('setTaskData refuses the reserved __outcome key and leaves state untouched', async () => {
      const layer = taskState();
      const before = emptyState();
      const { result, state } = await layer.provides.setTaskData.execute(
        {
          key: '__outcome',
          value: 'success',
        },
        before,
        makeCtx(),
      );
      expect(result).toContain('reserved');
      expect(state).toBe(before);
    });

    it('artifacts written by a child survive onReturn into the parent', async () => {
      const layer = taskState();
      const childWithFile = await layer.provides.recordArtifact.execute(
        {
          path: 'worker.ts',
        },
        emptyState(),
        makeCtx(),
      );
      assert(childWithFile.state !== undefined);
      const childWithData = await layer.provides.setTaskData.execute(
        {
          key: 'verdict',
          value: 'ok',
        },
        childWithFile.state,
        makeCtx(),
      );
      assert(childWithData.state !== undefined);

      const merged = await layer.hooks.onReturn!({
        childState: childWithData.state,
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'child-1',
        }),
        parentState: emptyState(),
        result: 'done',
      });
      assert(merged !== undefined);
      expect(merged.parentState.files).toEqual([
        'worker.ts',
      ]);
      expect(merged.parentState.data.verdict).toBe('ok');
    });
  });

  describe("mergeData: 'namespace' (fan-out)", () => {
    function stateWithData(data: Record<string, unknown>): TaskState {
      return {
        checkpoints: [],
        files: [],
        data,
      };
    }

    it('namespaces each child under its execution id instead of clobbering', async () => {
      const layer = taskState({
        mergeData: 'namespace',
      });
      const afterFirst = await layer.hooks.onReturn!({
        childState: stateWithData({
          result: 'from-worker-a',
        }),
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'worker-a',
        }),
        parentState: stateWithData({}),
        result: 'done',
      });
      assert(afterFirst !== undefined);

      const afterSecond = await layer.hooks.onReturn!({
        childState: stateWithData({
          result: 'from-worker-b',
        }),
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'worker-b',
        }),
        parentState: afterFirst.parentState,
        result: 'done',
      });
      assert(afterSecond !== undefined);

      // Both workers wrote `result`; neither contribution is lost.
      expect(afterSecond.parentState.data['worker-a']).toEqual({
        result: 'from-worker-a',
      });
      expect(afterSecond.parentState.data['worker-b']).toEqual({
        result: 'from-worker-b',
      });
    });

    it("shallow (default) loses the first worker's value for the same key", async () => {
      const layer = taskState();
      const afterFirst = await layer.hooks.onReturn!({
        childState: stateWithData({
          result: 'from-worker-a',
        }),
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'worker-a',
        }),
        parentState: stateWithData({}),
        result: 'done',
      });
      assert(afterFirst !== undefined);
      const afterSecond = await layer.hooks.onReturn!({
        childState: stateWithData({
          result: 'from-worker-b',
        }),
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'worker-b',
        }),
        parentState: afterFirst.parentState,
        result: 'done',
      });
      assert(afterSecond !== undefined);
      expect(afterSecond.parentState.data.result).toBe('from-worker-b');
    });

    it('namespace mode still unions files and concatenates checkpoints', async () => {
      const layer = taskState({
        mergeData: 'namespace',
      });
      const merged = await layer.hooks.onReturn!({
        childState: {
          checkpoints: [
            {
              timestamp: 2,
              depth: 1,
            },
          ],
          files: [
            'b.ts',
          ],
          data: {},
        },
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'worker-a',
        }),
        parentState: {
          checkpoints: [
            {
              timestamp: 1,
              depth: 0,
            },
          ],
          files: [
            'a.ts',
          ],
          data: {},
        },
        result: 'done',
      });
      assert(merged !== undefined);
      expect(merged.parentState.files).toEqual([
        'a.ts',
        'b.ts',
      ]);
      expect(merged.parentState.checkpoints).toHaveLength(2);
    });
  });

  describe('checkpoint cap + budget-aware recall (M5)', () => {
    function makeCheckpoints(count: number, startTs = 0): TaskState['checkpoints'] {
      return Array.from(
        {
          length: count,
        },
        (_, i) => ({
          timestamp: startTs + i,
          depth: 0,
        }),
      );
    }

    async function storeOnce(state: TaskState): Promise<TaskState> {
      const layer = taskState();
      const result = await layer.hooks.store!({
        newItems: [],
        log: makeItemLog(),
        response: {
          items: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        ctx: makeCtx(),
        state,
      });
      assert(result !== undefined);
      return result.state;
    }

    it('60 stores cap at 50 checkpoints, newest survive', async () => {
      let state: TaskState = {
        checkpoints: [],
        files: [],
        data: {},
      };
      for (let i = 0; i < 60; i++) {
        state = await storeOnce(state);
      }
      expect(state.checkpoints).toHaveLength(50);
      // Newest survive: the last checkpoint is the most recent one appended.
      const timestamps = state.checkpoints.map((c) => c.timestamp);
      expect(timestamps).toEqual(
        [
          ...timestamps,
        ].sort((a, b) => a - b),
      );
    });

    it('onReturn 40 + 40 checkpoints merges to 50 (newest kept)', async () => {
      const layer = taskState();
      const result = await layer.hooks.onReturn!({
        childState: {
          checkpoints: makeCheckpoints(40, 1_000),
          files: [],
          data: {},
        },
        childLog: makeItemLog(),
        childCtx: makeCtx({
          executionId: 'child-1',
        }),
        parentState: {
          checkpoints: makeCheckpoints(40, 0),
          files: [],
          data: {},
        },
        result: 'done',
      });
      assert(result !== undefined);
      expect(result.parentState.checkpoints).toHaveLength(50);
      // The 30 oldest parent checkpoints were dropped; all 40 child ones kept.
      expect(result.parentState.checkpoints[0].timestamp).toBe(30);
      expect(result.parentState.checkpoints[49].timestamp).toBe(1_039);
    });

    it('onComplete caps at 50 too', async () => {
      const layer = taskState();
      const result = await layer.hooks.onComplete!({
        log: makeItemLog(),
        ctx: makeCtx(),
        state: {
          checkpoints: makeCheckpoints(50),
          files: [],
          data: {},
        },
        outcome: 'success',
      });
      assert(result !== undefined);
      expect(result.state.checkpoints).toHaveLength(50);
    });

    async function recallText(state: TaskState, budget: number): Promise<string> {
      const layer = taskState();
      const recalled = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state,
        budget,
      });
      assert(recalled !== null && typeof recalled !== 'string');
      expect(recalled.tokenCount).toBeGreaterThan(0);
      const msg = recalled.items[0];
      assert(msg.type === 'message');
      const part = msg.content[0];
      assert(part.type === 'input_text');
      return part.text;
    }

    it('recall respects the budget by halving oldest checkpoints (N / N+1 boundary)', async () => {
      const state: TaskState = {
        checkpoints: makeCheckpoints(50),
        files: [
          'a.ts',
        ],
        data: {},
      };
      const fullText = `<task_state>\n${JSON.stringify(state, null, 2)}\n</task_state>`;
      const fullTokens = Math.ceil(fullText.length / 4);

      // Budget == full render (N): untouched.
      const atBudget = await recallText(state, fullTokens);
      expect(atBudget).toBe(fullText);

      // Budget == full render − 1 (N−1 / over-budget): oldest half dropped.
      const overBudget = await recallText(state, fullTokens - 1);
      expect(overBudget).not.toBe(fullText);
      expect(Math.ceil(overBudget.length / 4)).toBeLessThanOrEqual(fullTokens - 1);
      expect(overBudget.endsWith('</task_state>')).toBe(true);
      // Newest checkpoint still present, oldest gone.
      expect(overBudget).toContain('"timestamp": 49');
      expect(overBudget).not.toContain('"timestamp": 0,');
      // files/data survive trimming.
      expect(overBudget).toContain('a.ts');
    });

    it('recall char-slices with closing tag when even zero checkpoints overflow', async () => {
      const state: TaskState = {
        checkpoints: [],
        files: Array.from(
          {
            length: 100,
          },
          (_, i) => `file-${i}.ts`,
        ),
        data: {},
      };
      const text = await recallText(state, 20);
      expect(text.length).toBeLessThanOrEqual(20 * 4);
      expect(text.endsWith('\n</task_state>')).toBe(true);
    });

    it('budget 0 returns the full render untrimmed (fail-open, pinned)', async () => {
      const state: TaskState = {
        checkpoints: makeCheckpoints(50),
        files: [],
        data: {},
      };
      const text = await recallText(state, 0);
      expect(text).toBe(`<task_state>\n${JSON.stringify(state, null, 2)}\n</task_state>`);
    });

    it('cap holds across rehydration (cross-execution)', async () => {
      const layer = taskState();
      const storage = makeScopedStorage();
      await storage.set('state', {
        checkpoints: makeCheckpoints(50),
        files: [],
        data: {},
      });
      const initResult = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      const next = await storeOnce(initResult.state);
      expect(next.checkpoints).toHaveLength(50);
    });
  });
});
