import type { Step } from '@noetic/core';
import { frameworkCast } from '@noetic/core';

import type { EvalSuiteOptions } from '../types/eval';
import type { EvalContext } from './eval-context';
import { registerSuite } from './registry';

//#region Types

/** Widened step type for describe() — accepts Step with any I/O types. */
export type DescribeStep = {
  kind: Step['kind'];
  id: string;
};

export interface SuiteDefinition {
  step: Step;
  options: EvalSuiteOptions;
  cases: CaseDefinition[];
}

export interface CaseDefinition {
  name: string;
  fn: (ctx: EvalContext) => Promise<void>;
}

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
