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

//#endregion

//#region Active Cases State

let activeCases: CaseDefinition[] | null = null;

export function getActiveCases(): CaseDefinition[] | null {
  return activeCases;
}

//#endregion

//#region Public API

export function describe(config: EvalSuiteConfig, objective: EvalObjective, fn: () => void): void {
  const cases: CaseDefinition[] = [];
  const previous = activeCases;
  activeCases = cases;
  try {
    fn();
  } finally {
    activeCases = previous;
  }
  registerSuite({
    config,
    objective,
    cases,
  });
}

//#endregion
