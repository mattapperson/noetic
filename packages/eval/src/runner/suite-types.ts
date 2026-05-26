import type { Step } from '@noetic-tools/core';

import type { EvalSuiteOptions } from '../types/eval';
import type { EvalContext } from './eval-context';

export interface SuiteDefinition {
  step: Step;
  options: EvalSuiteOptions;
  cases: CaseDefinition[];
}

export interface CaseDefinition {
  name: string;
  fn: (ctx: EvalContext) => Promise<void>;
}
