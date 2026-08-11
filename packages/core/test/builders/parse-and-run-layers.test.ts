// `parseAndRunWorkflow` forwards its layer registry into hydration. Without it, a
// `provide` node's named layers resolve to NOTHING rather than failing (the hydrator
// treats an absent registry as "host runs with harness defaults"), so a host that runs
// layer-bearing documents silently loses every layer it declared.

import { describe, expect, it } from 'bun:test';
import type { ContextLayer } from '@noetic-tools/context';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { AgentHarness } from '../../src/harness/agent-harness';
import { createScriptedCallModel, makeLLMResponse } from '../_helpers';

const DOC = {
  version: 1,
  root: {
    kind: 'withContext' as const,
    id: 'with-layers',
    layers: [
      'task-state',
    ],
    child: {
      kind: 'callModel' as const,
      id: 'inner',
      model: 'openai/gpt-4o-mini',
      instructions: 'work',
    },
  },
};

function recordingLayer(recalls: string[]): ContextLayer {
  return frameworkCast({
    id: 'task-state',
    slot: 0,
    scope: 'thread',
    hooks: {
      recall: async () => {
        recalls.push('task-state');
        return null;
      },
    },
  });
}

function makeHarness(): AgentHarness {
  return new AgentHarness({
    name: 'layers-test',
    params: {},
    _testCallModel: createScriptedCallModel([
      makeLLMResponse('done'),
    ]),
  });
}

describe('parseAndRunWorkflow layer registry', () => {
  it('resolves a provide node against the registry it is given', async () => {
    const recalls: string[] = [];
    const harness = makeHarness();

    await parseAndRunWorkflow({
      json: DOC,
      harness,
      ctx: harness.createContext(),
      tools: [],
      input: 'go',
      layers: new Map([
        [
          'task-state',
          recordingLayer(recalls),
        ],
      ]),
    });

    expect(recalls).toEqual([
      'task-state',
    ]);
  });

  it('reports an unregistered layer name instead of running without it', async () => {
    const harness = makeHarness();
    const run = parseAndRunWorkflow({
      json: DOC,
      harness,
      ctx: harness.createContext(),
      tools: [],
      input: 'go',
      layers: new Map(),
    });

    await expect(run).rejects.toThrow(NoeticConfigError);
    await expect(run).rejects.toThrow(/task-state/);
  });

  it('still runs with no registry at all, so existing hosts are unaffected', async () => {
    const recalls: string[] = [];
    const harness = makeHarness();

    const output = await parseAndRunWorkflow({
      json: DOC,
      harness,
      ctx: harness.createContext(),
      tools: [],
      input: 'go',
    });

    expect(output).toBe('done');
    expect(recalls).toEqual([]);
  });
});
