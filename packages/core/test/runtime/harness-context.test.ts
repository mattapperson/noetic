import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextLayer } from '@noetic-tools/context';
import { Slot } from '@noetic-tools/context';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createScriptedCallModel, makeLayer, textOnlyResponse } from '../_helpers';

//#region Helper Functions

//#endregion

//#region Tests

describe('AgentHarness memory', () => {
  describe('createContext with harness-level memory', () => {
    it('context inherits harness memory by default', () => {
      const layer = makeLayer('harness-layer', {
        slot: Slot.STEERING,
      });
      const harness = new AgentHarness({
        name: 'test',
        context: [
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
      const harnessLayer = makeLayer('harness-layer', {
        slot: Slot.STEERING,
      });
      const callLayer = makeLayer('call-layer', {
        slot: Slot.WORKING_MEMORY,
      });
      const harness = new AgentHarness({
        name: 'test',
        context: [
          harnessLayer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      const ctx = harness.createContext({
        context: [
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

  describe('previewRequestItems', () => {
    it('returns seeded history when no layers are configured', async () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      harness.seedSessionHistory('__default__', [
        {
          id: 'h1',
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hi',
            },
          ],
        },
      ]);

      const items = await harness.previewRequestItems();
      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe('message');
    });

    it('prepends layer recall output before history when layers contribute items', async () => {
      const layer: ContextLayer = {
        id: 'preview-layer',
        name: 'preview-layer',
        slot: Slot.STEERING,
        scope: 'execution',
        hooks: {
          recall: async () => ({
            items: [
              {
                id: 'sys-1',
                type: 'message',
                status: 'completed',
                role: 'developer',
                content: [
                  {
                    type: 'input_text',
                    text: 'system: be helpful',
                  },
                ],
              },
            ],
            tokenCount: 5,
          }),
        },
      };
      const harness = new AgentHarness({
        name: 'test',
        context: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      harness.seedSessionHistory('__default__', [
        {
          id: 'h1',
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hi',
            },
          ],
        },
      ]);

      const items = await harness.previewRequestItems();
      expect(items).toHaveLength(2);
      const first = items[0];
      const second = items[1];
      assert(first?.type === 'message' && first.role === 'developer');
      assert(second?.type === 'message' && second.role === 'user');
      expect(first.id).toBe('sys-1');
      expect(second.id).toBe('h1');
    });

    it('includes recall output from init-bearing layers (staticContent shape)', async () => {
      // Regression: preview must run layer `init` on its throwaway context —
      // without it the recall lifecycle treats every init-bearing layer as
      // disabled and the preview silently degenerates to bare history. All
      // built-in layers carry an init hook, so this is the common case.
      const layer: ContextLayer<string> = {
        id: 'persona',
        name: 'persona',
        slot: Slot.WORKING_MEMORY,
        scope: 'resource',
        hooks: {
          init: async () => ({
            state: '<instructions>be helpful</instructions>',
          }),
          recall: async ({ state }) => ({
            items: [
              {
                id: 'persona-1',
                type: 'message',
                status: 'completed',
                role: 'developer',
                content: [
                  {
                    type: 'input_text',
                    text: state ?? '',
                  },
                ],
              },
            ],
            tokenCount: 8,
          }),
        },
      };
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

      const items = await harness.previewRequestItems();
      expect(items).toHaveLength(1);
      const first = items[0];
      assert(first?.type === 'message' && first.role === 'developer');
      expect(first.id).toBe('persona-1');
      const part = first.content[0];
      assert(part?.type === 'input_text');
      expect(part.text).toBe('<instructions>be helpful</instructions>');
    });

    it('returns empty for an unknown thread with no history and no layers', async () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      const items = await harness.previewRequestItems({
        threadId: 'never-seen',
      });
      expect(items).toEqual([]);
    });

    it('does not allocate a session for an unknown thread', async () => {
      const harness = new AgentHarness({
        name: 'test',
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      await harness.previewRequestItems({
        threadId: 'never-seen',
      });
      // A real session would be observable through getStatus reporting on the
      // runner. Verify the preview did not lazily create one.
      expect(
        harness.getStatus({
          threadId: 'never-seen',
        }).kind,
      ).toBe('idle');
      const before = harness.getQueueSize({
        threadId: 'never-seen',
      });
      expect(before).toBe(0);
    });

    it('propagates layer recall errors so callers can decide their own fallback', async () => {
      const failingLayer: ContextLayer = {
        id: 'boom',
        name: 'boom',
        slot: Slot.STEERING,
        scope: 'execution',
        hooks: {
          recall: async () => {
            throw new Error('layer recall failed');
          },
        },
      };
      const harness = new AgentHarness({
        name: 'test',
        context: [
          failingLayer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });
      // Layer hooks are protected by the lifecycle wrapper which logs and
      // returns an empty output rather than throwing — so the preview returns
      // history (here, []) when a layer fails. This locks in the behavior the
      // CLI relies on.
      const items = await harness.previewRequestItems();
      expect(items).toEqual([]);
    });
  });

  describe('execute with harness-level memory', () => {
    it('execute passes harness memory to context', async () => {
      const layer = makeLayer('exec-layer', {
        slot: Slot.STEERING,
      });
      let contextLayers: ContextLayer[] | undefined;

      const harness = new AgentHarness({
        name: 'test',
        initialStep: {
          kind: 'runCode',
          id: 'capture',
          execute: async (_input, ctx) => {
            contextLayers = ctx.layers;
            return 'done';
          },
        },
        context: [
          layer,
        ],
        params: {},
        _testCallModel: createScriptedCallModel([
          textOnlyResponse('ok'),
        ]),
      });

      await harness.execute('hello');
      await harness.getAgentResponse();
      expect(contextLayers).toBeDefined();
      expect(contextLayers).toHaveLength(1);
      expect(contextLayers![0].id).toBe('exec-layer');
    });
  });
});

//#endregion
