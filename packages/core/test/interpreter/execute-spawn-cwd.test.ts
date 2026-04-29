import { describe, expect, it } from 'bun:test';
import { executeSpawn } from '../../src/interpreter/execute-spawn';
import { ContextImpl } from '../../src/runtime/context-impl';
import { setToolCwd } from '../../src/runtime/cwd-helpers';
import type { Context } from '../../src/types/context';
import type { ContextMemory } from '../../src/types/memory';
import type { StepSpawn } from '../../src/types/step';
import { makeMockHarness, simpleExecute } from '../_helpers';

function makeSpawnStep<I, O>(
  id: string,
  execute: (input: I, ctx: Context<ContextMemory>) => Promise<O>,
): StepSpawn<ContextMemory, I, O> {
  return {
    kind: 'spawn',
    id,
    child: {
      kind: 'run',
      id: `${id}-child`,
      execute,
    },
  };
}

describe('executeSpawn — cwdState snapshot', () => {
  it('child snapshots parent.cwdState.cwd at spawn time', async () => {
    const parentCtx = new ContextImpl({
      harness: makeMockHarness(),
      cwdState: {
        cwd: '/parent-launch',
      },
    });

    let observedChildCwd = '';
    const step = makeSpawnStep<string, string>('snap', async (_input, childCtx) => {
      observedChildCwd = childCtx.cwdState.cwd;
      return 'done';
    });

    await executeSpawn(step, 'input', parentCtx, simpleExecute);
    expect(observedChildCwd).toBe('/parent-launch');
  });

  it('child mutation does not propagate to parent', async () => {
    const parentCtx = new ContextImpl({
      harness: makeMockHarness(),
      cwdState: {
        cwd: '/parent',
      },
    });

    const step = makeSpawnStep<string, string>('mutate', async (_input, childCtx) => {
      setToolCwd(childCtx, '/child-only');
      return 'done';
    });

    await executeSpawn(step, 'input', parentCtx, simpleExecute);
    expect(parentCtx.cwdState.cwd).toBe('/parent');
    expect(parentCtx.cwdState.previousCwd).toBeUndefined();
  });

  it('child sees parent.cwd updated by a prior parent setToolCwd', async () => {
    const parentCtx = new ContextImpl({
      harness: makeMockHarness(),
      cwdState: {
        cwd: '/initial',
      },
    });

    setToolCwd(parentCtx, '/after-cd');

    let observedChildCwd = '';
    const step = makeSpawnStep<string, string>('post-cd', async (_input, childCtx) => {
      observedChildCwd = childCtx.cwdState.cwd;
      return 'done';
    });

    await executeSpawn(step, 'input', parentCtx, simpleExecute);
    expect(observedChildCwd).toBe('/after-cd');
  });
});
