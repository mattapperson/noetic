// Every builder carries `durable` and `replayKey` onto the step it builds, so the
// interpreter sees them whatever kind the step is. See spec 23a § Identity.

import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { AcpAgent, Step } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { conditional, inParallel } from '../../src/builders/control-flow-builders';
import { decide, routeSwitch } from '../../src/builders/decide-builders';
import { schedule } from '../../src/builders/every';
import { loop } from '../../src/builders/loop-builder';
import { withContext } from '../../src/builders/provide-builder';
import { spawn } from '../../src/builders/spawn-builder';
import { callModel, invokeTool, runCode, step } from '../../src/builders/step-builders';
import { until } from '../../src/until/predicates';
import { makeMockContext, makeTestTool } from '../_helpers';

const replayKey = (input: unknown): string => `k:${String(input)}`;

const leaf = runCode<ContextData, string, string>({
  id: 'passthrough-leaf',
  execute: async (input: string) => input,
});

const YES_NO = {
  ok: {
    type: 'boolean',
    instructions: 'OK?',
  },
} as const;

/** One step per builder, each built with both replay controls. */
function buildAll(): Step[] {
  const gate = decide({
    id: 'passthrough-decide',
    model: 'test/model',
    questions: YES_NO,
    durable: false,
    replayKey,
  });
  return frameworkCast<Step[]>([
    runCode({
      id: 'passthrough-run',
      execute: async (i: string) => i,
      durable: false,
      replayKey,
    }),
    callModel({
      id: 'passthrough-model',
      model: 'test/model',
      durable: false,
      replayKey,
    }),
    invokeTool({
      id: 'passthrough-tool',
      tool: makeTestTool(),
      durable: false,
      replayKey,
    }),
    step.acpAgent({
      id: 'passthrough-acp',
      agent: frameworkCast<AcpAgent>({}),
      prompt: 'hi',
      durable: false,
      replayKey,
    }),
    gate,
    routeSwitch({
      id: 'passthrough-switch',
      decide: gate,
      on: 'ok',
      cases: {
        true: leaf,
        false: leaf,
      },
      uncertain: leaf,
      durable: false,
      replayKey,
    }),
    conditional({
      id: 'passthrough-conditional',
      route: () => null,
      durable: false,
      replayKey,
    }),
    inParallel({
      id: 'passthrough-fan',
      mode: 'race',
      paths: () => [
        leaf,
      ],
      durable: false,
      replayKey,
    }),
    spawn({
      id: 'passthrough-spawn',
      child: leaf,
      durable: false,
      replayKey,
    }),
    withContext({
      id: 'passthrough-with-context',
      child: leaf,
      context: [],
      durable: false,
      replayKey,
    }),
    loop({
      id: 'passthrough-loop',
      steps: [
        leaf,
      ],
      until: until.maxSteps(1),
      durable: false,
      replayKey,
    }),
    schedule({
      id: 'passthrough-schedule',
      step: leaf,
      interval: 1e3,
      durable: false,
      replayKey,
    }),
  ]);
}

describe('replay controls pass through every builder', () => {
  it('keeps durable and replayKey on every step kind', () => {
    const built = buildAll();
    expect(new Set(built.map((s) => s.kind)).size).toBe(11);
    const ctx = makeMockContext();
    for (const s of built) {
      expect(s.durable).toBe(false);
      expect(s.replayKey?.('x', ctx)).toBe('k:x');
    }
  });

  it('leaves both unset when the caller omits them', () => {
    const plain = runCode({
      id: 'passthrough-plain',
      execute: async (i: string) => i,
    });
    expect(plain.durable).toBeUndefined();
    expect(plain.replayKey).toBeUndefined();
  });
});
