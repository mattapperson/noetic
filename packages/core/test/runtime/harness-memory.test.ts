import { describe, expect, it } from 'bun:test';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { MemoryLayer } from '../../src/types/memory';
import { Slot } from '../../src/types/memory';
import { createScriptedCallModel, textOnlyResponse } from '../_helpers';

//#region Helper Functions

function makeLayer(id: string, slot: number): MemoryLayer {
  return {
    id,
    name: id,
    slot,
    scope: 'execution',
    hooks: {},
  };
}

//#endregion

//#region Tests

describe('AgentHarness memory', () => {
  describe('createContext with harness-level memory', () => {
    it('context inherits harness memory by default', () => {
      const layer = makeLayer('harness-layer', Slot.Steering);
      const harness = new AgentHarness({
        name: 'test',
        memory: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext();
      expect(ctx.layers).toBeDefined();
      expect(ctx.layers).toHaveLength(1);
      expect(ctx.layers![0].id).toBe('harness-layer');
    });

    it('per-call memory overrides harness memory', () => {
      const harnessLayer = makeLayer('harness-layer', Slot.Steering);
      const callLayer = makeLayer('call-layer', Slot.Working);
      const harness = new AgentHarness({
        name: 'test',
        memory: [
          harnessLayer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext({
        memory: [
          callLayer,
        ],
      });
      expect(ctx.layers).toHaveLength(1);
      expect(ctx.layers![0].id).toBe('call-layer');
    });

    it('no memory on harness or call produces undefined layers', () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext();
      expect(ctx.layers).toBeUndefined();
    });
  });

  describe('execute with harness-level memory', () => {
    it('execute passes harness memory to context', async () => {
      const layer = makeLayer('exec-layer', Slot.Steering);
      let contextLayers: MemoryLayer[] | undefined;

      const harness = new AgentHarness({
        name: 'test',
        initialStep: {
          kind: 'run',
          id: 'capture',
          execute: async (_input, ctx) => {
            contextLayers = ctx.layers;
            return 'done';
          },
        },
        memory: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      await harness.execute('hello');
      expect(contextLayers).toBeDefined();
      expect(contextLayers).toHaveLength(1);
      expect(contextLayers![0].id).toBe('exec-layer');
    });
  });
});

//#endregion
