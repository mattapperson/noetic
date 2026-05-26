/**
 * Tests for the plan-file store and flow JSON schema.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowNode } from '../src/plan/flow-schema.js';
import { validateFlow, walkFlow } from '../src/plan/flow-schema.js';

//#region Flow schema

describe('validateFlow', () => {
  test('accepts a minimal llm node', () => {
    const node: FlowNode = {
      kind: 'llm',
      id: 'root',
      instructions: 'do the thing',
    };
    const result = validateFlow(node);
    expect(result.kind).toBe('llm');
    expect(result.id).toBe('root');
  });

  test('accepts a fork with two llm paths', () => {
    const node: FlowNode = {
      kind: 'fork',
      id: 'parallel',
      mode: 'all',
      paths: [
        {
          kind: 'llm',
          id: 'a',
          instructions: 'A',
        },
        {
          kind: 'llm',
          id: 'b',
          instructions: 'B',
        },
      ],
    };
    const result = validateFlow(node);
    expect(result.kind).toBe('fork');
  });

  test('accepts a subagent node', () => {
    const node: FlowNode = {
      kind: 'subagent',
      id: 'explore-1',
      preset: 'explore',
      prompt: 'find auth code',
    };
    expect(validateFlow(node).kind).toBe('subagent');
  });

  test('accepts deeply nested sequence + spawn', () => {
    const node: FlowNode = {
      kind: 'sequence',
      id: 'seq',
      steps: [
        {
          kind: 'spawn',
          id: 'spawn-1',
          child: {
            kind: 'llm',
            id: 'inner',
            instructions: 'work',
          },
        },
      ],
    };
    expect(validateFlow(node).kind).toBe('sequence');
  });

  test('rejects unknown kind', () => {
    expect(() =>
      validateFlow({
        kind: 'bogus',
        id: 'x',
      }),
    ).toThrow();
  });

  test('rejects missing required field', () => {
    expect(() =>
      validateFlow({
        kind: 'llm',
        id: 'x',
      }),
    ).toThrow();
  });

  test('rejects empty fork paths', () => {
    expect(() =>
      validateFlow({
        kind: 'fork',
        id: 'p',
        mode: 'all',
        paths: [],
      }),
    ).toThrow();
  });

  test('rejects empty id', () => {
    expect(() =>
      validateFlow({
        kind: 'llm',
        id: '',
        instructions: 'x',
      }),
    ).toThrow();
  });
});

describe('walkFlow', () => {
  test('yields every node in a tree depth-first', () => {
    const root: FlowNode = {
      kind: 'fork',
      id: 'root',
      mode: 'all',
      paths: [
        {
          kind: 'sequence',
          id: 'seq',
          steps: [
            {
              kind: 'llm',
              id: 'a',
              instructions: 'A',
            },
            {
              kind: 'llm',
              id: 'b',
              instructions: 'B',
            },
          ],
        },
        {
          kind: 'llm',
          id: 'c',
          instructions: 'C',
        },
      ],
    };
    const ids = Array.from(walkFlow(root)).map((n) => n.id);
    expect(ids).toEqual([
      'root',
      'seq',
      'a',
      'b',
      'c',
    ]);
  });
});

//#endregion

//#region File store (uses real fs in a temp HOME)

async function withTempPlansRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'noetic-plans-'));
  const prev = process.env.NOETIC_PLANS_ROOT;
  process.env.NOETIC_PLANS_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) {
      delete process.env.NOETIC_PLANS_ROOT;
    } else {
      process.env.NOETIC_PLANS_ROOT = prev;
    }
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

describe('plan file store', () => {
  test('createPlanSession + writePrd + readPlanSession round-trip', async () => {
    await withTempPlansRoot(async () => {
      const store = await import('../src/plan/file-store.js');
      const session = await store.createPlanSession();
      expect(session.slug.length).toBeGreaterThan(0);
      expect(session.dir).toContain(session.slug);

      await store.writePrd(session.slug, '# Hello\n\nWorld');
      const contents = await store.readPlanSession(session.slug);
      expect(contents.prd).toBe('# Hello\n\nWorld');
      expect(contents.flow).toBeNull();
      expect(contents.subPlans).toEqual({});
    });
  });

  test('writeFlow validates and persists JSON', async () => {
    await withTempPlansRoot(async () => {
      const store = await import('../src/plan/file-store.js');
      const session = await store.createPlanSession();
      const flow: FlowNode = {
        kind: 'llm',
        id: 'root',
        instructions: 'go',
      };
      await store.writeFlow(session.slug, flow);
      const contents = await store.readPlanSession(session.slug);
      expect(contents.flow).toEqual(flow);
    });
  });

  test('writeFlow rejects invalid JSON', async () => {
    await withTempPlansRoot(async () => {
      const store = await import('../src/plan/file-store.js');
      const session = await store.createPlanSession();
      await expect(
        store.writeFlow(session.slug, {
          kind: 'nope',
        }),
      ).rejects.toThrow();
    });
  });

  test('writeSubPlan rejects path-traversal nodeIds', async () => {
    await withTempPlansRoot(async () => {
      const store = await import('../src/plan/file-store.js');
      const session = await store.createPlanSession();
      await expect(store.writeSubPlan(session.slug, '../escape', 'hi')).rejects.toThrow();
    });
  });

  test('listPlanSessions returns created session slugs', async () => {
    await withTempPlansRoot(async () => {
      const store = await import('../src/plan/file-store.js');
      const a = await store.createPlanSession();
      const b = await store.createPlanSession();
      const list = await store.listPlanSessions();
      expect(list).toContain(a.slug);
      expect(list).toContain(b.slug);
    });
  });

  test('listPlanSessions returns [] when no sessions exist', async () => {
    await withTempPlansRoot(async () => {
      const store = await import('../src/plan/file-store.js');
      const list = await store.listPlanSessions();
      expect(list).toEqual([]);
    });
  });
});

//#endregion
