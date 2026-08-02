/**
 * The memory -> context rename ships as a MINOR bump, which is only honest if
 * every pre-rename public name still resolves and every pre-rename config key
 * still wires through. These tests are the gate on that claim — if one fails,
 * the change is breaking and the version bump is wrong.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { ContextMemory } from '../src/index';
import {
  AgentHarness,
  context,
  memory,
  observationalContext,
  observationalMemory,
  planContext,
  planMemory,
  provide,
  react,
  spawn,
  step,
  temporalContext,
  temporalMemory,
  tool,
  toolContextLayer,
  toolMemoryLayer,
  workingMemory,
  workingMemoryContext,
} from '../src/index';
import { makeLayer, makeMockContext, makeMockToolContext } from './_helpers';

const noopStep = step.run<ContextMemory, string, string>({
  id: 'alias-noop',
  execute: async (input: string) => input,
});

describe('deprecated value aliases', () => {
  it('resolves to the exact same binding, not a copy', () => {
    expect(memory).toBe(context);
    expect(workingMemory).toBe(workingMemoryContext);
    expect(observationalMemory).toBe(observationalContext);
    expect(temporalMemory).toBe(temporalContext);
    expect(planMemory).toBe(planContext);
    expect(toolMemoryLayer).toBe(toolContextLayer);
  });

  it('keeps the `memory()` builder producing a usable ContextConfig', () => {
    const layer = makeLayer('aliased');
    const config = memory([
      layer,
    ]);
    expect(config.layers).toEqual([
      layer,
    ]);
  });
});

describe('deprecated `memory:` config key', () => {
  it('provide() accepts it and normalises to `context`', () => {
    const layer = makeLayer('provide-compat');
    const built = provide({
      id: 'provide-compat-step',
      child: noopStep,
      memory: [
        layer,
      ],
    });
    expect(built.context).toEqual([
      layer,
    ]);
  });

  it('provide() prefers `context` when both are supplied', () => {
    const preferred = makeLayer('preferred');
    const stale = makeLayer('stale');
    const built = provide({
      id: 'provide-precedence-step',
      child: noopStep,
      context: [
        preferred,
      ],
      memory: [
        stale,
      ],
    });
    expect(built.context).toEqual([
      preferred,
    ]);
  });

  it('provide() throws MISSING_CONTEXT_LAYERS when neither key is supplied', () => {
    try {
      provide({
        id: 'provide-empty-step',
        child: noopStep,
      });
      throw new Error('expected provide() to throw');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'NoeticConfigError',
        code: 'MISSING_CONTEXT_LAYERS',
      });
    }
  });

  it('spawn() accepts it', () => {
    const layer = makeLayer('spawn-compat');
    const built = spawn({
      id: 'spawn-compat-step',
      child: noopStep,
      memory: [
        layer,
      ],
    });
    expect(built.context).toEqual([
      layer,
    ]);
  });

  it('react() accepts it', () => {
    const layer = makeLayer('react-compat');
    const built = react({
      model: 'test/model',
      tools: [],
      memory: [
        layer,
      ],
    });
    // With layers configured, react wraps the loop in a spawn.
    expect(built.kind).toBe('spawn');
  });

  it('tool() accepts it', () => {
    const built = tool({
      name: 'compat-tool',
      description: 'exercises the deprecated memory key',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
      memory: {
        id: 'compat-tool-state',
        init: () => ({}),
        recall: () => null,
      },
    });
    expect(built.context).toBeDefined();
  });

  it('AgentHarness accepts it and applies the layers to created contexts', () => {
    const layer = makeLayer('harness-compat');
    const harness = new AgentHarness({
      name: 'compat-harness',
      params: {},
      memory: [
        layer,
      ],
    });
    const ctx = harness.createContext();
    expect(ctx.layers).toEqual([
      layer,
    ]);
  });
});

describe('deprecated `ctx.memory` accessor', () => {
  it('is the same object as `ctx.context` in the shared test mocks too', () => {
    // The mocks stand in for ContextImpl in most of the suite. If they let the
    // two accessors diverge, every test using them would be asserting against a
    // shape the runtime never produces.
    const mockCtx = makeMockContext();
    expect(mockCtx.memory).toBe(mockCtx.context);
    const mockToolCtx = makeMockToolContext();
    expect(mockToolCtx.memory).toBe(mockToolCtx.context);
  });

  it('keeps the two in sync when a caller overrides only `context`', () => {
    // `makeMockContext` spreads overrides last, so a bare `context` override
    // would otherwise orphan `memory` on the original object.
    const replacement = {
      todo: {
        items: [],
      },
    };
    const ctx = makeMockContext({
      context: replacement,
    });
    expect(ctx.context).toBe(replacement);
    expect(ctx.memory).toBe(replacement);
  });

  it('is non-optional, so pre-rename indexing still compiles', () => {
    const harness = new AgentHarness({
      name: 'indexing-harness',
      params: {},
      context: [
        makeLayer('indexed'),
      ],
    });
    const ctx = harness.createContext();
    // No optional chaining and no guard: if `memory` were declared optional
    // this would not typecheck, which is the exact break the alias prevents.
    const handle = ctx.memory['indexed'];
    expect(handle).toEqual(ctx.context['indexed']);
  });

  it('returns the same object as `ctx.context`', () => {
    const harness = new AgentHarness({
      name: 'accessor-harness',
      params: {},
      context: [
        makeLayer('accessor'),
      ],
    });
    const ctx = harness.createContext();
    expect(ctx.memory).toBe(ctx.context);
  });
});
