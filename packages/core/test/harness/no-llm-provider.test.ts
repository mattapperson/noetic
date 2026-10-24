import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '@noetic-tools/types';
import { loop } from '../../src/builders/loop-builder';
import { spawn } from '../../src/builders/spawn-builder';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { someStep } from '../../src/interpreter/step-walk';
import { until } from '../../src/until/predicates';

//#region Helper Functions

const CREDENTIAL_VARS = [
  'NOETIC_API_KEY',
  'NOETIC_BASE_URL',
  'OPENROUTER_API_KEY',
] as const;

function bareHarness(): AgentHarness {
  return new AgentHarness({
    name: 'no-credentials',
    params: {},
  });
}

async function expectNoProvider(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    expect.unreachable();
  } catch (e) {
    assert(isNoeticConfigError(e));
    expect(e.code).toBe('NO_LLM_PROVIDER');
  }
}

//#endregion

//#region Tests

describe('missing LLM provider', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of CREDENTIAL_VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('run() fails before an earlier runCode step has any effect', async () => {
    const effects: string[] = [];
    const graph = loop({
      id: 'no-provider-loop',
      steps: [
        runCode({
          id: 'no-provider-effect',
          execute: async () => {
            effects.push('ran');
            return 'x';
          },
        }),
        spawn({
          id: 'no-provider-spawn',
          child: callModel({
            id: 'no-provider-generate',
            model: 'm/x',
          }),
        }),
      ],
      until: until.maxSteps(1),
    });
    const harness = bareHarness();

    await expectNoProvider(() => harness.run(graph, 'hi', harness.createContext()));
    expect(effects).toEqual([]);
  });

  it('execute() rejects up front when the agent graph needs a model', async () => {
    const harness = new AgentHarness({
      name: 'no-credentials',
      params: {},
      agentGraph: callModel({
        id: 'no-provider-graph',
        model: 'm/x',
      }),
    });

    await expectNoProvider(() => harness.execute('hi'));
  });

  it('run() leaves a model-free step tree alone', async () => {
    const harness = bareHarness();
    const ctx = harness.createContext();
    const result = await harness.run(
      runCode({
        id: 'no-provider-pure',
        execute: async (input: string) => `${input}!`,
      }),
      'hi',
      ctx,
    );
    expect(result).toBe('hi!');
    expect(ctx.tokens.input).toBe(0);
  });
});

describe('someStep', () => {
  it('finds a model step nested inside loop and spawn', () => {
    const graph = loop({
      id: 'walk-loop',
      steps: [
        spawn({
          id: 'walk-spawn',
          child: callModel({
            id: 'walk-generate',
            model: 'm/x',
          }),
        }),
      ],
      until: until.maxSteps(1),
    });
    expect(someStep(graph, (s) => s.kind === 'callModel')).toBe(true);
    expect(someStep(graph, (s) => s.kind === 'decide')).toBe(false);
  });
});

//#endregion
