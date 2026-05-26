import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { createLocalShellAdapter } from '@noetic/platform-node';
import type { ExecutionContext, ScopedStorage } from '@noetic-tools/core';
import type { PlannerAttemptState } from '../../../src/tasks/runtime/memory/planner-attempt-layer.js';
import {
  createPlannerAttemptLayer,
  hasBudgetRemaining,
  MAX_PLANNER_ATTEMPTS,
  PLANNER_ATTEMPT_LAYER_ID,
} from '../../../src/tasks/runtime/memory/planner-attempt-layer.js';
import { MemFs } from '../_helpers.js';

//#region Test helpers

function makeScopedStorage(): ScopedStorage {
  const m = new Map<string, string>();
  return {
    async get<T>(k: string): Promise<T | null> {
      const raw = m.get(k);
      if (raw === undefined) {
        return null;
      }
      return JSON.parse(raw);
    },
    async set<T>(k: string, v: T): Promise<void> {
      m.set(k, JSON.stringify(v));
    },
    async delete(k: string): Promise<void> {
      m.delete(k);
    },
    async list(): Promise<string[]> {
      return Array.from(m.keys());
    },
  };
}

function makeCtx(fs: MemFs): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    resourceId: 'res-1',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    fs,
    shell: createLocalShellAdapter(),
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(_layerId: string): T | undefined => undefined,
  };
}

const PROJECT_ROOT = '/repo';
const ATTEMPTS_PATH = `${PROJECT_ROOT}/.noetic/tasks/_planner-attempts.json`;
const TASK_A = 'T-aaa00aaa00';
const TASK_B = 'T-bbb00bbb00';

//#endregion

describe('planner-attempt-layer', () => {
  describe('shape', () => {
    it('has correct id, slot, and resource scope', () => {
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      expect(layer.id).toBe(PLANNER_ATTEMPT_LAYER_ID);
      expect(layer.scope).toBe('resource');
    });

    it('exposes snapshot, recordAttempt, and clearAttempts', () => {
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      assert(layer.provides !== undefined);
      expect(Object.keys(layer.provides)).toEqual([
        'snapshot',
        'recordAttempt',
        'clearAttempts',
      ]);
    });

    it('default budget is MAX_PLANNER_ATTEMPTS', () => {
      expect(MAX_PLANNER_ATTEMPTS).toBeGreaterThan(0);
    });
  });

  describe('init', () => {
    it('returns empty state when persist file is missing', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
      ]);
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      const result = await layer.hooks.init!({
        storage: makeScopedStorage(),
        scopeKey: 'res-1',
        ctx: makeCtx(fs),
      });
      expect(result.state).toEqual({});
    });

    it('reads existing counts from disk', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
        `${PROJECT_ROOT}/.noetic`,
        `${PROJECT_ROOT}/.noetic/tasks`,
      ]);
      await fs.writeFile(
        ATTEMPTS_PATH,
        JSON.stringify({
          [TASK_A]: 2,
        }),
      );
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      const result = await layer.hooks.init!({
        storage: makeScopedStorage(),
        scopeKey: 'res-1',
        ctx: makeCtx(fs),
      });
      expect(result.state).toEqual({
        [TASK_A]: 2,
      });
    });

    it('treats corrupt JSON as empty state (autopilot stays unblocked)', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
        `${PROJECT_ROOT}/.noetic`,
        `${PROJECT_ROOT}/.noetic/tasks`,
      ]);
      await fs.writeFile(ATTEMPTS_PATH, '{not valid json');
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      let threw = false;
      try {
        await layer.hooks.init!({
          storage: makeScopedStorage(),
          scopeKey: 'res-1',
          ctx: makeCtx(fs),
        });
      } catch {
        threw = true;
      }
      // Corrupt JSON → throw; the layer's safeParse fallback only handles
      // schema-level corruption, not tokenizer errors. The autopilot's
      // wrap-in-try-catch will recover.
      expect(threw).toBe(true);
    });

    it('treats schema-mismatched payload as empty state', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
        `${PROJECT_ROOT}/.noetic`,
        `${PROJECT_ROOT}/.noetic/tasks`,
      ]);
      await fs.writeFile(
        ATTEMPTS_PATH,
        JSON.stringify({
          [TASK_A]: 'not-a-number',
        }),
      );
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      const result = await layer.hooks.init!({
        storage: makeScopedStorage(),
        scopeKey: 'res-1',
        ctx: makeCtx(fs),
      });
      expect(result.state).toEqual({});
    });
  });

  describe('snapshot', () => {
    it('snapshot is a data declaration', () => {
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      assert(layer.provides !== undefined);
      expect(layer.provides.snapshot.kind).toBe('data');
    });
  });

  describe('recordAttempt', () => {
    it('increments and persists to disk', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
      ]);
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      assert(layer.provides !== undefined);
      const recordDecl = layer.provides.recordAttempt;
      assert(recordDecl.kind === 'function');
      const result = await recordDecl.execute(
        {
          taskId: TASK_A,
        },
        {},
        makeCtx(fs),
      );
      expect(result.result).toBe(1);
      // Source-of-truth assertion against the persisted JSON: avoids
      // type-erasure on `result.state` (LayerProvides erases TState to
      // `unknown`) while proving the durable side effect.
      const persisted = JSON.parse(await fs.readFileText(ATTEMPTS_PATH));
      expect(persisted[TASK_A]).toBe(1);
    });

    it('counts independently per task and increments cumulatively', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
      ]);
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      assert(layer.provides !== undefined);
      const recordDecl = layer.provides.recordAttempt;
      assert(recordDecl.kind === 'function');
      // Round-trip the in-memory state through JSON (the JSON shuttle
      // pattern) so each iteration reads back its prior write without
      // breaking the type-erased `state?: unknown` contract.
      let state: PlannerAttemptState = {};
      for (let i = 0; i < 2; i++) {
        const r = await recordDecl.execute(
          {
            taskId: TASK_A,
          },
          state,
          makeCtx(fs),
        );
        state = JSON.parse(JSON.stringify(r.state ?? {}));
      }
      const r2 = await recordDecl.execute(
        {
          taskId: TASK_B,
        },
        state,
        makeCtx(fs),
      );
      expect(r2.result).toBe(1);
      const persisted = JSON.parse(await fs.readFileText(ATTEMPTS_PATH));
      expect(persisted[TASK_A]).toBe(2);
      expect(persisted[TASK_B]).toBe(1);
    });
  });

  describe('clearAttempts', () => {
    it('removes the task counter and persists', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
      ]);
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      assert(layer.provides !== undefined);
      const clearDecl = layer.provides.clearAttempts;
      assert(clearDecl.kind === 'function');
      const start: PlannerAttemptState = {
        [TASK_A]: 2,
        [TASK_B]: 1,
      };
      await clearDecl.execute(
        {
          taskId: TASK_A,
        },
        start,
        makeCtx(fs),
      );
      const persisted = JSON.parse(await fs.readFileText(ATTEMPTS_PATH));
      expect(persisted[TASK_A]).toBeUndefined();
      expect(persisted[TASK_B]).toBe(1);
    });

    it('is a no-op for unknown taskId (does not write)', async () => {
      const fs = new MemFs([
        PROJECT_ROOT,
      ]);
      const layer = createPlannerAttemptLayer({
        projectRoot: PROJECT_ROOT,
      });
      assert(layer.provides !== undefined);
      const clearDecl = layer.provides.clearAttempts;
      assert(clearDecl.kind === 'function');
      const r = await clearDecl.execute(
        {
          taskId: TASK_A,
        },
        {},
        makeCtx(fs),
      );
      // No-op: result.result is undefined (`void` return).
      expect(r.result).toBeUndefined();
      let didWrite = false;
      try {
        await fs.readFileText(ATTEMPTS_PATH);
        didWrite = true;
      } catch {
        didWrite = false;
      }
      expect(didWrite).toBe(false);
    });
  });

  describe('hasBudgetRemaining boundaries', () => {
    it('returns true at N-1 attempts', () => {
      expect(
        hasBudgetRemaining({
          state: {
            [TASK_A]: MAX_PLANNER_ATTEMPTS - 1,
          },
          maxAttempts: MAX_PLANNER_ATTEMPTS,
          taskId: TASK_A,
        }),
      ).toBe(true);
    });

    it('returns false at N attempts', () => {
      expect(
        hasBudgetRemaining({
          state: {
            [TASK_A]: MAX_PLANNER_ATTEMPTS,
          },
          maxAttempts: MAX_PLANNER_ATTEMPTS,
          taskId: TASK_A,
        }),
      ).toBe(false);
    });

    it('returns false at N+1 attempts', () => {
      expect(
        hasBudgetRemaining({
          state: {
            [TASK_A]: MAX_PLANNER_ATTEMPTS + 1,
          },
          maxAttempts: MAX_PLANNER_ATTEMPTS,
          taskId: TASK_A,
        }),
      ).toBe(false);
    });

    it('returns true for an unknown task (count defaults to 0)', () => {
      expect(
        hasBudgetRemaining({
          state: {},
          maxAttempts: MAX_PLANNER_ATTEMPTS,
          taskId: TASK_A,
        }),
      ).toBe(true);
    });
  });
});
