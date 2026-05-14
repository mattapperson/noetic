import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ExecutionContext, FsAdapter, ItemLog, ScopedStorage } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';
import { createLocalShellAdapter } from '@noetic/platform-node';

import { createSteeringFileLayer } from '../src/memory/steering-file-layer.js';
import { MemFs } from './tasks/_helpers.js';

//#region Helpers

function makeCtx(fs: FsAdapter): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
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
    readLayerState: <T>(_id: string): T | undefined => undefined,
  };
}

function makeStorage(): ScopedStorage {
  const store = new Map<string, string>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      if (raw === undefined) {
        return null;
      }
      return JSON.parse(raw);
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<string[]> {
      return Array.from(store.keys());
    },
  };
}

function makeEmptyLog(): ItemLog {
  const items: never[] = [];
  return {
    get items(): ReadonlyArray<never> {
      return items;
    },
    append(): void {},
  };
}

interface RunRecallOpts {
  fs: FsAdapter;
}

async function runRecall(opts: RunRecallOpts): Promise<string | null | object> {
  const layer = createSteeringFileLayer();
  if (layer.hooks.init === undefined || layer.hooks.recall === undefined) {
    throw new Error('hooks missing');
  }
  const ctx = makeCtx(opts.fs);
  const { state } = await layer.hooks.init({
    storage: makeStorage(),
    scopeKey: 'test',
    ctx,
  });
  return layer.hooks.recall({
    log: makeEmptyLog(),
    query: '',
    ctx,
    state,
    budget: 0,
  });
}

//#endregion

//#region Tests

describe('createSteeringFileLayer', () => {
  const ORIGINAL_TASK_DIR = process.env.NOETIC_TASK_DIR;

  beforeEach(() => {
    delete process.env.NOETIC_TASK_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_TASK_DIR === undefined) {
      delete process.env.NOETIC_TASK_DIR;
      return;
    }
    process.env.NOETIC_TASK_DIR = ORIGINAL_TASK_DIR;
  });

  it('uses Slot.STEERING (90) and id "steering-file"', () => {
    const layer = createSteeringFileLayer();
    expect(layer.id).toBe('steering-file');
    expect(layer.slot).toBe(Slot.STEERING);
    expect(layer.slot).toBe(90);
    expect(layer.scope).toBe('execution');
  });

  it('returns null from recall when NOETIC_TASK_DIR is unset', async () => {
    const fs = new MemFs([
      '/repo',
    ]);
    const result = await runRecall({
      fs,
    });
    expect(result).toBeNull();
  });

  it('returns null from recall when NOETIC_TASK_DIR is the empty string', async () => {
    process.env.NOETIC_TASK_DIR = '';
    const fs = new MemFs([
      '/repo',
    ]);
    const result = await runRecall({
      fs,
    });
    expect(result).toBeNull();
  });

  it('returns null when NOETIC_TASK_DIR is set but steering.md is missing (ENOENT)', async () => {
    process.env.NOETIC_TASK_DIR = '/repo/.noetic/tasks/T-abcdefghij';
    const fs = new MemFs([
      '/repo/.noetic/tasks/T-abcdefghij',
    ]);
    const result = await runRecall({
      fs,
    });
    expect(result).toBeNull();
  });

  it('returns null when steering.md exists but is empty', async () => {
    const taskDir = '/repo/.noetic/tasks/T-abcdefghij';
    process.env.NOETIC_TASK_DIR = taskDir;
    const fs = new MemFs([
      taskDir,
    ]);
    await fs.writeFile(`${taskDir}/steering.md`, '');
    const result = await runRecall({
      fs,
    });
    expect(result).toBeNull();
  });

  it('returns the file contents as a developer-message string when both env and file are present', async () => {
    const taskDir = '/repo/.noetic/tasks/T-abcdefghij';
    process.env.NOETIC_TASK_DIR = taskDir;
    const body = 'Prefer minimal diffs. Avoid touching tests in unrelated packages.';
    const fs = new MemFs([
      taskDir,
    ]);
    await fs.writeFile(`${taskDir}/steering.md`, body);

    const result = await runRecall({
      fs,
    });

    expect(typeof result).toBe('string');
    if (typeof result !== 'string') {
      throw new Error('unreachable');
    }
    expect(result.startsWith('# Task Steering')).toBe(true);
    expect(result).toContain(body);
  });

  it('handles a NOETIC_TASK_DIR with a trailing slash without producing a double slash', async () => {
    const taskDir = '/repo/.noetic/tasks/T-abcdefghij';
    process.env.NOETIC_TASK_DIR = `${taskDir}/`;
    const body = 'steer body';
    const fs = new MemFs([
      taskDir,
    ]);
    await fs.writeFile(`${taskDir}/steering.md`, body);

    const result = await runRecall({
      fs,
    });

    expect(typeof result).toBe('string');
    if (typeof result !== 'string') {
      throw new Error('unreachable');
    }
    expect(result).toContain(body);
  });

  it('rethrows non-ENOENT FS errors so silent corruption is impossible', async () => {
    const taskDir = '/repo/.noetic/tasks/T-abcdefghij';
    process.env.NOETIC_TASK_DIR = taskDir;
    const fs = new MemFs([
      taskDir,
    ]);
    // Replace readFileText with one that throws a non-ENOENT error.
    const realRead = fs.readFileText.bind(fs);
    fs.readFileText = async (p: string): Promise<string> => {
      if (p.endsWith('/steering.md')) {
        const err = new Error('EACCES: permission denied');
        Object.assign(err, {
          code: 'EACCES',
        });
        throw err;
      }
      return realRead(p);
    };

    await expect(
      runRecall({
        fs,
      }),
    ).rejects.toThrow(/EACCES/);
  });
});

//#endregion
