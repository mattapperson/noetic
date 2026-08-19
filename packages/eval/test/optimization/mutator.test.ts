import { describe, expect, test } from 'bun:test';
import type { AcpAgent, Step } from '@noetic-tools/core';
import { spawn, step } from '@noetic-tools/core';
import { applyCandidate } from '../../src/optimization/mutator';

function mockAcpAgent(agentId: string): AcpAgent {
  return {
    specificationVersion: 'acp-v1',
    agentId,
    async connect() {
      throw new Error('the optimizer never connects to an agent');
    },
  };
}

function getCallModelInstructions(s: Step): string | undefined {
  if (s.kind !== 'callModel') {
    throw new Error(`Expected callModel step, got ${s.kind}`);
  }
  const { instructions } = s;
  if (typeof instructions === 'function') {
    throw new Error(
      'Expected eager string instructions on callModel step, got function-form Lazy getter',
    );
  }
  return instructions;
}

function getCallModelModel(s: Step): string {
  if (s.kind !== 'callModel') {
    throw new Error(`Expected callModel step, got ${s.kind}`);
  }
  const { model } = s;
  if (typeof model === 'function') {
    throw new Error('Expected eager string model on callModel step, got function-form Lazy getter');
  }
  return model;
}

function getSpawnChild(s: Step): Step {
  if (s.kind !== 'spawn') {
    throw new Error(`Expected spawn step, got ${s.kind}`);
  }
  return s.child;
}

describe('applyCandidate', () => {
  test('replaces instructions in StepCallModel', () => {
    const callModelStep: Step = {
      kind: 'callModel',
      id: 'my-llm',
      model: 'test-model',
      instructions: 'Original prompt',
    };

    const result = applyCandidate(callModelStep, {
      'my-llm.instructions': 'Optimized prompt',
    });

    expect(result.kind).toBe('callModel');
    expect(getCallModelInstructions(result)).toBe('Optimized prompt');
  });

  test('does not mutate the original step', () => {
    const callModelStep: Step = {
      kind: 'callModel',
      id: 'my-llm',
      model: 'test-model',
      instructions: 'Original prompt',
    };

    applyCandidate(callModelStep, {
      'my-llm.instructions': 'Optimized prompt',
    });

    expect(getCallModelInstructions(callModelStep)).toBe('Original prompt');
  });

  test('replaces instructions in nested StepSpawn > StepCallModel', () => {
    const callModelStep: Step = {
      kind: 'callModel',
      id: 'inner-llm',
      model: 'test-model',
      instructions: 'Inner original',
    };

    const spawnStep = spawn({
      id: 'outer-spawn',
      child: callModelStep,
    });

    const result = applyCandidate(spawnStep, {
      'outer-spawn.inner-llm.instructions': 'Inner optimized',
    });

    expect(result.kind).toBe('spawn');
    const child = getSpawnChild(result);
    expect(getCallModelInstructions(child)).toBe('Inner optimized');
  });

  test('preserves fields not in the candidate map', () => {
    const callModelStep: Step = {
      kind: 'callModel',
      id: 'my-llm',
      model: 'test-model',
      instructions: 'Keep this',
    };

    const result = applyCandidate(callModelStep, {});

    expect(result.kind).toBe('callModel');
    expect(getCallModelInstructions(result)).toBe('Keep this');
    expect(getCallModelModel(result)).toBe('test-model');
  });

  test('clones runCode step without error', () => {
    const runCodeStep: Step = {
      kind: 'runCode',
      id: 'my-run',
      execute: async (input: unknown) => input,
    };

    const result = applyCandidate(runCodeStep, {});

    expect(result.kind).toBe('runCode');
    expect(result.id).toBe('my-run');
    expect(result).not.toBe(runCodeStep);
  });

  // Regression: adding a step kind to the `Step` union once made
  // `cloneAndReplace` non-exhaustive — tsc failed with TS2366, and at runtime
  // the missing case returned `undefined` for any such step the optimizer
  // touched. Lock in the pass-through behaviour for the ACP agent kind.
  describe('acp-agent step kind (regression)', () => {
    test('clones an acp-agent step without throwing or returning undefined', () => {
      const original = step.acpAgent({
        id: 'cc',
        agent: mockAcpAgent('claude-code'),
        prompt: 'do a thing',
      });

      const result: Step | undefined = applyCandidate(original, {});

      expect(result).toBeDefined();
      expect(result.kind).toBe('acp-agent');
      expect(result.id).toBe(original.id);
    });

    test('an acp-agent step nested in a spawn is cloned through', () => {
      const original = spawn({
        id: 'outer',
        child: step.acpAgent({
          id: 'inner',
          agent: mockAcpAgent('codex'),
          prompt: 'do a thing',
        }),
      });

      const result: Step | undefined = applyCandidate(original, {});

      expect(result).toBeDefined();
      expect(result.kind).toBe('spawn');
    });
  });
});
