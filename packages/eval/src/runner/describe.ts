import type { Step } from '@noetic/core';
import { frameworkCast } from '@noetic/core';

import type { EvalObjective, EvalSuiteConfig } from '../types/eval';
import type { EvalContext } from './eval-context';
import { registerSuite } from './registry';

//#region Types

export interface SuiteDefinition {
  config: EvalSuiteConfig;
  objective: EvalObjective;
  cases: CaseDefinition[];
}

export interface CaseDefinition {
  name: string;
  fn: (ctx: EvalContext) => Promise<void>;
}

/** Widened config type for describe() — accepts Step with any I/O types. */
export type DescribeConfig = Omit<EvalSuiteConfig, 'step'> & {
  step: {
    kind: Step['kind'];
    id: string;
  };
};

//#endregion

//#region Active Cases State

let activeCases: CaseDefinition[] | null = null;

export function getActiveCases(): CaseDefinition[] | null {
  return activeCases;
}

//#endregion

//#region Public API

export function describe(config: DescribeConfig, objective: EvalObjective, fn: () => void): void {
  const cases: CaseDefinition[] = [];
  const previous = activeCases;
  activeCases = cases;
  try {
    fn();
  } finally {
    activeCases = previous;
  }
  registerSuite({
    config: frameworkCast<EvalSuiteConfig>(config),
    objective,
    cases,
  });
}

//#endregion
