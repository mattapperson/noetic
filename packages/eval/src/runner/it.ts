import * as fs from 'node:fs';

import type { CaseDefinition } from './describe';
import { getActiveCases } from './describe';
import type { EvalContext } from './eval-context';

//#region Helper Functions

function assertActiveCases(): CaseDefinition[] {
  const cases = getActiveCases();
  if (!cases) {
    throw new Error('it() must be called inside describe()');
  }
  return cases;
}

type DatasetFn<T> = (
  ctx: EvalContext & {
    example: T;
  },
) => Promise<void>;

function mergeExample<T>(
  ctx: EvalContext,
  example: T,
): EvalContext & {
  example: T;
} {
  return {
    ...ctx,
    example,
  };
}

function createDatasetCase<T>(name: string, example: T, fn: DatasetFn<T>): CaseDefinition {
  return {
    name,
    fn: async (ctx: EvalContext) => {
      await fn(mergeExample(ctx, example));
    },
  };
}

//#endregion

//#region Public API

export function it(name: string, fn: (ctx: EvalContext) => Promise<void>): void {
  const cases = assertActiveCases();
  cases.push({
    name,
    fn,
  });
}

it.each = function each<T>(
  dataset: string | T[],
  fn: (
    ctx: EvalContext & {
      example: T;
    },
  ) => Promise<void>,
): void {
  const cases = assertActiveCases();

  if (typeof dataset === 'string') {
    const content = fs.readFileSync(dataset, 'utf-8');
    const examples: T[] = content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (let i = 0; i < examples.length; i++) {
      cases.push(createDatasetCase(`[dataset] ${dataset} (${i})`, examples[i], fn));
    }
    return;
  }

  for (let i = 0; i < dataset.length; i++) {
    const example = dataset[i];
    cases.push(createDatasetCase(`[dataset ${i}]`, example, fn));
  }
};

//#endregion
