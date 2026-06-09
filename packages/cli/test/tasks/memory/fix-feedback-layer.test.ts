import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ExecutionContext, Item, ItemLog, ScopedStorage } from '@noetic-tools/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic-tools/platform-node';
import type { AssertionOutcome } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { AssertionStatus } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import type { FixFeedbackState } from '../../../src/tasks/runtime/memory/fix-feedback-layer.js';
import {
  applyFixFeedbackUpdate,
  createFixFeedbackLayer,
  FIX_FEEDBACK_LAYER_ID,
  formatFixFeedback,
} from '../../../src/tasks/runtime/memory/fix-feedback-layer.js';

//#region Test helpers

function makeScopedStorage(): ScopedStorage {
  // JSON shuttle launders the generic across the interface boundary without
  // a type assertion (`JSON.parse` returns `any`).
  const map = new Map<string, string>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const v = map.get(key);
      if (v === undefined) {
        return null;
      }
      return JSON.parse(v);
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async list(prefix?: string): Promise<string[]> {
      const keys = Array.from(map.keys());
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

function makeCtx(): ExecutionContext {
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
    fs: createLocalFsAdapter(),
    shell: createLocalShellAdapter(),
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(_layerId: string): T | undefined => undefined,
  };
}

function makeItemLog(): ItemLog {
  const items: Item[] = [];
  return {
    get items() {
      return items;
    },
    append(item: Item) {
      items.push(item);
    },
  };
}

const ASSERTION_FAIL: AssertionOutcome = {
  assertionId: 'A-fail00fail',
  status: AssertionStatus.Failed,
  message: 'expected 200, got 500',
};

const ASSERTION_PASS: AssertionOutcome = {
  assertionId: 'A-pass00pass',
  status: AssertionStatus.Passed,
};

//#endregion

describe('fix-feedback-layer', () => {
  describe('shape', () => {
    it('has correct id, slot, and scope', () => {
      const layer = createFixFeedbackLayer();
      expect(layer.id).toBe(FIX_FEEDBACK_LAYER_ID);
      expect(layer.scope).toBe('thread');
      expect(layer.slot).toBeGreaterThan(0);
    });
  });

  describe('formatFixFeedback', () => {
    it('returns null when state is empty', () => {
      const text = formatFixFeedback({
        plan: '',
        description: '',
        accumulatedIssues: [],
        attempt: 1,
      });
      expect(text).toBeNull();
    });

    it('renders plan + description on attempt 1', () => {
      const text = formatFixFeedback({
        plan: 'Build the thing',
        description: 'It must do X.',
        accumulatedIssues: [],
        attempt: 1,
      });
      assert(text !== null);
      expect(text).toContain('## Plan');
      expect(text).toContain('Build the thing');
      expect(text).toContain('## Original description');
      expect(text).toContain('It must do X.');
      expect(text).not.toContain('Attempt 2');
      expect(text).not.toContain('Prior validation issues');
    });

    it('includes prior issues on attempt > 1', () => {
      const text = formatFixFeedback({
        plan: 'Build the thing',
        description: '',
        accumulatedIssues: [
          ASSERTION_FAIL,
        ],
        attempt: 2,
      });
      assert(text !== null);
      expect(text).toContain('Attempt 2 after 1 failed validation(s)');
      expect(text).toContain('## Prior validation issues');
      expect(text).toContain('A-fail00fail');
      expect(text).toContain('expected 200, got 500');
    });
  });

  describe('init', () => {
    it('uses opts.initial when storage is empty', async () => {
      const layer = createFixFeedbackLayer({
        initial: {
          plan: 'seeded plan',
          description: 'seeded description',
        },
      });
      const result = await layer.hooks.init!({
        storage: makeScopedStorage(),
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state.plan).toBe('seeded plan');
      expect(result.state.description).toBe('seeded description');
      expect(result.state.attempt).toBe(1);
      expect(result.state.accumulatedIssues).toEqual([]);
    });

    it('prefers persisted storage over opts.initial', async () => {
      const storage = makeScopedStorage();
      const persisted: FixFeedbackState = {
        plan: 'persisted',
        description: '',
        accumulatedIssues: [
          ASSERTION_FAIL,
        ],
        attempt: 3,
      };
      await storage.set('state', persisted);
      const layer = createFixFeedbackLayer({
        initial: {
          plan: 'seeded',
        },
      });
      const result = await layer.hooks.init!({
        storage,
        scopeKey: 'thread-1',
        ctx: makeCtx(),
      });
      expect(result.state).toEqual(persisted);
    });
  });

  describe('recall', () => {
    it('returns null when state is empty', async () => {
      const layer = createFixFeedbackLayer();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: {
          plan: '',
          description: '',
          accumulatedIssues: [],
          attempt: 1,
        },
        budget: 4_000,
      });
      expect(result).toBeNull();
    });

    it('emits a developer-role item containing the formatted block', async () => {
      const layer = createFixFeedbackLayer();
      const result = await layer.hooks.recall!({
        log: makeItemLog(),
        query: '',
        ctx: makeCtx(),
        state: {
          plan: 'Build the thing',
          description: 'X must work',
          accumulatedIssues: [
            ASSERTION_FAIL,
          ],
          attempt: 2,
        },
        budget: 4_000,
      });
      assert(result !== null);
      assert(typeof result !== 'string');
      expect(result.items).toHaveLength(1);
      const msg = result.items[0];
      assert(msg.type === 'message');
      expect(msg.role).toBe('developer');
      const part = msg.content[0];
      assert(part.type === 'input_text');
      expect(part.text).toContain('Attempt 2');
      expect(part.text).toContain('A-fail00fail');
      expect(result.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('applyFixFeedbackUpdate', () => {
    // Tests the pure update semantics. The layerFn `update` is a thin
    // wrapper around this function — its `state?: unknown` return
    // signature means tests against `result.state` carry no static
    // shape, so we cover the merge logic at this lower level instead.

    it('merges plan/description and accumulates new issues, dedup-by-id', () => {
      const initial: FixFeedbackState = {
        plan: 'p1',
        description: '',
        accumulatedIssues: [
          ASSERTION_FAIL,
        ],
        attempt: 1,
      };
      const after1 = applyFixFeedbackUpdate(initial, {
        description: 'd1',
        newIssues: [
          ASSERTION_PASS,
        ],
        attempt: 2,
      });
      expect(after1.plan).toBe('p1');
      expect(after1.description).toBe('d1');
      expect(after1.attempt).toBe(2);
      // Two distinct assertionIds → both retained.
      expect(after1.accumulatedIssues).toHaveLength(2);
      // Same-id issue overwrites the prior outcome (latest wins).
      const after2 = applyFixFeedbackUpdate(after1, {
        newIssues: [
          {
            assertionId: ASSERTION_FAIL.assertionId,
            status: AssertionStatus.Passed,
          },
        ],
      });
      expect(after2.accumulatedIssues).toHaveLength(2);
      const overwritten = after2.accumulatedIssues.find(
        (i) => i.assertionId === ASSERTION_FAIL.assertionId,
      );
      assert(overwritten !== undefined);
      expect(overwritten.status).toBe(AssertionStatus.Passed);
    });

    it('omitted fields preserve prior state', () => {
      const start: FixFeedbackState = {
        plan: 'plan-a',
        description: 'desc-a',
        accumulatedIssues: [
          ASSERTION_FAIL,
        ],
        attempt: 4,
      };
      expect(applyFixFeedbackUpdate(start, {})).toEqual(start);
    });

    it('layer.provides.update wires through applyFixFeedbackUpdate', async () => {
      const layer = createFixFeedbackLayer();
      const updateDecl = layer.provides!.update;
      assert(updateDecl.kind === 'function');
      const initial: FixFeedbackState = {
        plan: 'p',
        description: '',
        accumulatedIssues: [],
        attempt: 1,
      };
      const r = await updateDecl.execute(
        {
          description: 'updated',
        },
        initial,
        makeCtx(),
      );
      // result.state is type-erased to `unknown`; assert via JSON
      // round-trip to keep the test type-clean.
      const persisted: FixFeedbackState = JSON.parse(JSON.stringify(r.state ?? initial));
      expect(persisted.description).toBe('updated');
      expect(persisted.plan).toBe('p');
    });
  });

  describe('onSpawn', () => {
    it('clones parent state for the child', async () => {
      const layer = createFixFeedbackLayer();
      const parent: FixFeedbackState = {
        plan: 'parent-plan',
        description: '',
        accumulatedIssues: [
          ASSERTION_FAIL,
        ],
        attempt: 2,
      };
      const result = await layer.hooks.onSpawn!({
        parentState: parent,
        childCtx: makeCtx(),
      });
      assert(result !== null);
      assert(result.childState !== null);
      expect(result.childState).toEqual(parent);
      // Independent copy — mutating the array on the child must not
      // affect the parent.
      expect(result.childState.accumulatedIssues).not.toBe(parent.accumulatedIssues);
    });
  });
});
