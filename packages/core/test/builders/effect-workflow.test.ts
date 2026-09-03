import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { EffectStepRuntime } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { hydrateWorkflow } from '../../src/builders/workflow-hydrator';
import { WorkflowDocumentSchema } from '../../src/schemas/workflow';

/**
 * The `effect` node's runtime is resolved from `HydrationContext.effectRuntimes`
 * — the test uses a hand-rolled runtime so this package needs no `effect`
 * dependency (the isolation invariant under test).
 */
const runtime: EffectStepRuntime<ContextData, unknown, string> = {
  run: (input) => Promise.resolve(`effect ran: ${String(input)}`),
};

describe('effect workflow node', () => {
  it('validates an effect node in a workflow document', () => {
    const doc = WorkflowDocumentSchema.parse({
      version: 1,
      root: {
        kind: 'effect',
        id: 'fx',
        ref: 'shout',
      },
    });
    expect(doc.root.kind).toBe('effect');
  });

  it('rejects an effect node with an empty ref', () => {
    expect(() =>
      WorkflowDocumentSchema.parse({
        version: 1,
        root: {
          kind: 'effect',
          id: 'fx',
          ref: '',
        },
      }),
    ).toThrow();
  });

  it('hydrates an effect node into a registered runtime', async () => {
    const step = hydrateWorkflow(
      {
        version: 1,
        root: {
          kind: 'effect',
          id: 'fx',
          ref: 'shout',
        },
      },
      {
        tools: new Map(),
        executeStep: async (_step, input) => frameworkCast(input),
        effectRuntimes: new Map([
          [
            'shout',
            frameworkCast<EffectStepRuntime<never, never, string>>(runtime),
          ],
        ]),
      },
    );
    expect(step.kind).toBe('effect');
  });

  it('throws UNKNOWN_EFFECT_RUNTIME_REFERENCE for an unregistered ref', () => {
    expect(() =>
      hydrateWorkflow(
        {
          version: 1,
          root: {
            kind: 'effect',
            id: 'fx',
            ref: 'missing',
          },
        },
        {
          tools: new Map(),
          executeStep: async (_step, input) => frameworkCast(input),
        },
      ),
    ).toThrow(/UNKNOWN_EFFECT_RUNTIME_REFERENCE|not registered/);
  });
});
