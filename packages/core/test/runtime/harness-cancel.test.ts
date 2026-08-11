import { describe, expect, it } from 'bun:test';
import type { ContextLayer } from '@noetic-tools/context';
import { Slot } from '@noetic-tools/context';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ContextImpl } from '../../src/runtime/context-impl';
import { createScriptedCallModel, textOnlyResponse } from '../_helpers';

//#region Helper Functions

function makeHarness(context?: ContextLayer[]): AgentHarness {
  return new AgentHarness({
    name: 'test',
    params: {},
    contextLayers: context,
    _testCallModel: createScriptedCallModel([
      textOnlyResponse('ok'),
    ]),
  });
}

/** Layer that records its teardown hooks (and the outcome) into `trace`. */
function makeTracingLayer(id: string, trace: string[]): ContextLayer {
  return {
    id,
    name: id,
    slot: Slot.WORKING_MEMORY,
    scope: 'execution',
    hooks: {
      async onComplete({ outcome }) {
        trace.push(`${id}:onComplete:${outcome}`);
      },
      async dispose() {
        trace.push(`${id}:dispose`);
      },
    },
  };
}

//#endregion

//#region Tests

describe('AgentHarness.cancel', () => {
  it('aborts the target context and every live descendant', async () => {
    const harness = makeHarness();
    const root = harness.createContext();
    const child = new ContextImpl({
      harness,
      parent: root,
    });
    const grandchild = new ContextImpl({
      harness,
      parent: child,
    });

    await harness.cancel(root, 'user pressed stop');

    expect(root.aborted).toBe(true);
    expect(root.abortReason).toBe('user pressed stop');
    expect(child.aborted).toBe(true);
    expect(grandchild.aborted).toBe(true);
    expect(grandchild.abortReason).toBe('user pressed stop');
  });

  it("runs each layer's onComplete with outcome 'aborted', then dispose", async () => {
    const trace: string[] = [];
    const harness = makeHarness([
      makeTracingLayer('root-layer', trace),
    ]);
    const root = harness.createContext();

    await harness.cancel(root, 'stop');

    expect(trace).toEqual([
      'root-layer:onComplete:aborted',
      'root-layer:dispose',
    ]);
  });

  it('tears layers down bottom-up: a child context before its parent', async () => {
    const trace: string[] = [];
    const harness = makeHarness([
      makeTracingLayer('root-layer', trace),
    ]);
    const root = harness.createContext();
    new ContextImpl({
      harness,
      parent: root,
      layers: [
        makeTracingLayer('child-layer', trace),
      ],
    });

    await harness.cancel(root, 'stop');

    expect(trace).toEqual([
      'child-layer:onComplete:aborted',
      'child-layer:dispose',
      'root-layer:onComplete:aborted',
      'root-layer:dispose',
    ]);
  });

  it('is a no-op on an already-cancelled context', async () => {
    const trace: string[] = [];
    const harness = makeHarness([
      makeTracingLayer('root-layer', trace),
    ]);
    const root = harness.createContext();
    root.abort('already gone');

    await harness.cancel(root, 'second time');

    expect(root.abortReason).toBe('already gone');
    expect(trace).toEqual([]);
  });

  it('skips a detached child — a settled spawn has nothing left to cancel', async () => {
    const trace: string[] = [];
    const harness = makeHarness();
    const root = harness.createContext();
    const settled = new ContextImpl({
      harness,
      parent: root,
      layers: [
        makeTracingLayer('settled-layer', trace),
      ],
    });
    settled.detachFromParent();

    await harness.cancel(root, 'stop');

    expect(settled.aborted).toBe(false);
    expect(trace).toEqual([]);
  });

  it('aborts a context with no layers without error', async () => {
    const harness = makeHarness();
    const root = harness.createContext();

    await harness.cancel(root);

    expect(root.aborted).toBe(true);
    expect(root.abortReason).toBeUndefined();
  });
});

//#endregion
