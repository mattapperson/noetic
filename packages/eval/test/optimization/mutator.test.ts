import { describe, expect, test } from 'bun:test';
import type { Step } from '@noetic/core';
import { spawn, step } from '@noetic/core';
import { applyCandidate } from '../../src/optimization/mutator';

function getLlmSystem(s: Step): string | undefined {
  if (s.kind !== 'llm') {
    throw new Error(`Expected llm step, got ${s.kind}`);
  }
  return s.system;
}

function getLlmModel(s: Step): string {
  if (s.kind !== 'llm') {
    throw new Error(`Expected llm step, got ${s.kind}`);
  }
  return s.model;
}

function getSpawnChild(s: Step): Step {
  if (s.kind !== 'spawn') {
    throw new Error(`Expected spawn step, got ${s.kind}`);
  }
  return s.child;
}

describe('applyCandidate', () => {
  test('replaces system prompt in StepLLM', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      system: 'Original prompt',
    });

    const result = applyCandidate(llmStep, {
      'my-llm.system': 'Optimized prompt',
    });

    expect(result.kind).toBe('llm');
    expect(getLlmSystem(result)).toBe('Optimized prompt');
  });

  test('does not mutate the original step', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      system: 'Original prompt',
    });

    applyCandidate(llmStep, {
      'my-llm.system': 'Optimized prompt',
    });

    expect(llmStep.system).toBe('Original prompt');
  });

  test('replaces system prompt in nested StepSpawn > StepLLM', () => {
    const llmStep = step.llm({
      id: 'inner-llm',
      model: 'test-model',
      system: 'Inner original',
    });

    const spawnStep = spawn({
      id: 'outer-spawn',
      child: llmStep,
    });

    const result = applyCandidate(spawnStep, {
      'outer-spawn.inner-llm.system': 'Inner optimized',
    });

    expect(result.kind).toBe('spawn');
    const child = getSpawnChild(result);
    expect(getLlmSystem(child)).toBe('Inner optimized');
  });

  test('preserves fields not in the candidate map', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      system: 'Keep this',
    });

    const result = applyCandidate(llmStep, {});

    expect(result.kind).toBe('llm');
    expect(getLlmSystem(result)).toBe('Keep this');
    expect(getLlmModel(result)).toBe('test-model');
  });

  test('clones run step without error', () => {
    const runStep = step.run({
      id: 'my-run',
      execute: async (input: unknown) => input,
    });

    const result = applyCandidate(runStep, {});

    expect(result.kind).toBe('run');
    expect(result.id).toBe('my-run');
    expect(result).not.toBe(runStep);
  });
});
