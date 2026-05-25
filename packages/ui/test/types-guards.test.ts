/**
 * Tests for client-side StepData type guards.
 *
 * Each guard must:
 *  - reject `undefined`
 *  - identify its own shape positively
 *  - reject siblings (don't claim another guard's shape)
 *
 * Sibling rejection is the load-bearing case — a poorly written guard would
 * cause the wrong inspector summary or node component to render.
 */

import { describe, expect, it } from 'bun:test';
import type {
  BranchStepData,
  EveryStepData,
  ForkStepData,
  LLMStepData,
  LoopStepData,
  RunStepData,
  SpawnStepData,
  StepData,
  ToolStepData,
} from '../src/client/types';
import {
  isBranchStepData,
  isEveryStepData,
  isForkStepData,
  isLLMStepData,
  isLoopStepData,
  isRunStepData,
  isSpawnStepData,
  isToolStepData,
} from '../src/client/types';

//#region Sample Step Data

const everySample: EveryStepData = {
  ms: 1000,
  jitter: 100,
  onError: 'continue',
  bodyStepId: 'poll',
  bodyStepKind: 'tool',
};

const loopSample: LoopStepData = {
  iteration: 1,
  totalIterations: 5,
  maxIterations: 10,
};

const llmSample: LLMStepData = {
  model: 'gpt-4',
  messages: [],
  payloadMessages: [],
  toolCalls: [],
  tokenUsage: {
    input: 0,
    output: 0,
    total: 0,
  },
  cost: 0,
};

const toolSample: ToolStepData = {
  toolName: 'search',
  arguments: {},
  result: null,
};

const branchSample: BranchStepData = {
  condition: 'x > 0',
  selectedPath: 0,
};

const forkSample: ForkStepData = {
  mode: 'race',
  pathCount: 2,
};

const spawnSample: SpawnStepData = {
  childStepId: 'child',
  childStepKind: 'run',
};

const runSample: RunStepData = {
  description: 'do thing',
};

//#endregion

describe('StepData type guards', () => {
  describe('isEveryStepData', () => {
    it('rejects undefined', () => {
      expect(isEveryStepData(undefined)).toBe(false);
    });

    it('accepts a proper every shape', () => {
      expect(isEveryStepData(everySample)).toBe(true);
    });

    it('accepts an every shape with optional wakeOn', () => {
      expect(
        isEveryStepData({
          ...everySample,
          wakeOn: 'inbox',
        }),
      ).toBe(true);
    });

    it('rejects when ms is not a number', () => {
      const bad = {
        ...everySample,
        ms: '1000' as unknown as number,
      };
      expect(isEveryStepData(bad as unknown as StepData)).toBe(false);
    });

    it('rejects when bodyStepId is missing', () => {
      const { bodyStepId: _omit, ...rest } = everySample;
      expect(isEveryStepData(rest as unknown as StepData)).toBe(false);
    });

    it('rejects loop, llm, tool, branch, fork, spawn, run shapes', () => {
      expect(isEveryStepData(loopSample)).toBe(false);
      expect(isEveryStepData(llmSample)).toBe(false);
      expect(isEveryStepData(toolSample)).toBe(false);
      expect(isEveryStepData(branchSample)).toBe(false);
      expect(isEveryStepData(forkSample)).toBe(false);
      expect(isEveryStepData(spawnSample)).toBe(false);
      expect(isEveryStepData(runSample)).toBe(false);
    });
  });

  describe('isLoopStepData (regression: must reject every)', () => {
    it('accepts a proper loop shape', () => {
      expect(isLoopStepData(loopSample)).toBe(true);
    });

    it('rejects an every shape (every has no maxIterations)', () => {
      // Without the maxIterations check, every's `iteration` field
      // would falsely match and route it to the loop summary.
      expect(isLoopStepData(everySample)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isLoopStepData(undefined)).toBe(false);
    });

    it('rejects when iteration is non-numeric', () => {
      const bad = {
        ...loopSample,
        iteration: '1' as unknown as number,
      };
      expect(isLoopStepData(bad as unknown as StepData)).toBe(false);
    });
  });

  describe('peer guards stay narrow', () => {
    it('isLLMStepData rejects every', () => {
      expect(isLLMStepData(everySample)).toBe(false);
    });

    it('isToolStepData rejects every', () => {
      expect(isToolStepData(everySample)).toBe(false);
    });

    it('isBranchStepData rejects every', () => {
      expect(isBranchStepData(everySample)).toBe(false);
    });

    it('isForkStepData rejects every', () => {
      expect(isForkStepData(everySample)).toBe(false);
    });

    it('isSpawnStepData rejects every', () => {
      expect(isSpawnStepData(everySample)).toBe(false);
    });

    it('isRunStepData rejects every', () => {
      expect(isRunStepData(everySample)).toBe(false);
    });
  });
});
