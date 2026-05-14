import type { Step } from '@noetic-tools/core';
import { frameworkCast } from '@noetic-tools/core/unstable';

import type { EvalSuiteOptions } from '../types/eval';
import { registerSuite } from './registry';
import type { CaseDefinition } from './suite-types';

export type { CaseDefinition, SuiteDefinition } from './suite-types';

//#region Types

/** Widened step type for describe() — accepts Step with any I/O types. */
export type DescribeStep = {
  kind: Step['kind'];
  id: string;
};

//#endregion

//#region Active Cases State

let activeCases: CaseDefinition[] | null = null;

export function getActiveCases(): CaseDefinition[] | null {
  return activeCases;
}

//#endregion

//#region Public API

export function describe(step: DescribeStep, options: EvalSuiteOptions, fn: () => void): void {
  const cases: CaseDefinition[] = [];
  const previous = activeCases;
  activeCases = cases;
  try {
    fn();
  } finally {
    activeCases = previous;
  }
  registerSuite({
    step: frameworkCast<Step>(step),
    options,
    cases,
  });
}

//#endregion
