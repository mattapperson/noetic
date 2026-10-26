import { describe, expect, it } from 'bun:test';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ContextImpl } from '../../src/runtime/context-impl';
import { Drains, drainsOf } from '../../src/runtime/drain';
import { makeMockContext } from '../_helpers';

function makeHarness(): AgentHarness {
  return new AgentHarness({
    name: 'drain',
    params: {},
  });
}

describe('Drains', () => {
  it('waits for a call until its caller reaches a step end, not just until its response', async () => {
    const harness = makeHarness();
    const drains = harness.drains;
    const root = harness.createContext();
    const finished = drains.track(root, {
      kind: 'model_round',
      model: 'm',
      round: 0,
    });
    let stopped = false;

    const draining = drains.run(root, 60e3, async () => {
      stopped = true;
      root.abort('drained');
    });
    finished();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(drains.covering(root)?.deadline).toBeGreaterThan(Date.now());

    drains.release(root);
    await draining;
    expect(stopped).toBe(true);
    expect(drains.covering(root)).toBeUndefined();
  });

  it('holds a step beneath a drain until the drain stops the tree', async () => {
    const harness = makeHarness();
    const drains = harness.drains;
    const root = harness.createContext();
    const child = new ContextImpl({
      harness,
      parent: root,
    });
    drains.track(child, {
      kind: 'decide',
      model: 'm',
    });
    const draining = drains.run(root, 60e3, async () => {
      root.abort('drained');
    });

    let held = true;
    const hold = drains.hold(child).then(() => {
      held = false;
    });
    await Promise.resolve();
    expect(held).toBe(true);

    expect(drains.stop(root)).toBe(draining);
    await hold;
    expect(held).toBe(false);
    expect(child.aborted).toBe(true);
  });

  it('ends the drain when someone else aborts the tree', async () => {
    const harness = makeHarness();
    const root = harness.createContext();
    harness.drains.track(root, {
      kind: 'decide',
      model: 'm',
    });
    const draining = harness.drains.run(root, 60e3, async () => {});

    root.abort('elsewhere');

    await draining;
    expect(harness.drains.covering(root)).toBeUndefined();
  });

  it('ignores calls with no context and stops nothing it is not draining', async () => {
    const drains = new Drains();
    const root = makeMockContext();

    drains.track(undefined, {
      kind: 'decide',
      model: 'm',
    })();
    await drains.hold(root);

    expect(drains.stop(root)).toBeUndefined();
    expect(drains.covering(root)).toBeUndefined();
  });
});

describe('drainsOf', () => {
  it("finds the harness's drains, and nothing on a harness without them", () => {
    const harness = makeHarness();

    expect(drainsOf(harness.createContext())).toBe(harness.drains);
    expect(drainsOf(makeMockContext())).toBeUndefined();
    expect(drainsOf(undefined)).toBeUndefined();
  });
});
