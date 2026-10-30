import type { ContextData, Step, StepSequence, Steps } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';

//#region Helpers

/** Every step kind, so an array element can be checked before it runs. */
const STEP_KINDS: Readonly<Record<Step['kind'], true>> = {
  runCode: true,
  callModel: true,
  'acp-agent': true,
  invokeTool: true,
  decide: true,
  conditional: true,
  inParallel: true,
  spawn: true,
  withContext: true,
  loop: true,
  schedule: true,
  call: true,
  wait: true,
  verify: true,
  sequence: true,
};

function isStepList(steps: unknown): steps is ReadonlyArray<unknown> {
  return Array.isArray(steps);
}

function isStepKind(kind: unknown): kind is Step['kind'] {
  return typeof kind === 'string' && Object.hasOwn(STEP_KINDS, kind);
}

/** What is wrong with an array element, or `undefined` when it is a step. */
function elementProblem(element: unknown): string | undefined {
  if (Array.isArray(element)) {
    return 'is a nested array';
  }
  if (typeof element !== 'object' || element === null) {
    return `is ${element === null ? 'null' : typeof element}, not a step`;
  }
  const { kind, id } = frameworkCast<{
    kind?: unknown;
    id?: unknown;
  }>(element);
  if (!isStepKind(kind)) {
    return `has no known step kind (got ${JSON.stringify(kind)})`;
  }
  if (typeof id !== 'string') {
    return 'has no string id';
  }
  return undefined;
}

/**
 * Checks every element is a step, so a bad array fails where it is built
 * rather than as a raw TypeError when it runs.
 *
 * @throws `NoeticConfigError` `INVALID_STEP_IN_ARRAY` naming the first bad element.
 */
function requireSteps(list: ReadonlyArray<unknown>): ReadonlyArray<Step<never, never, unknown>> {
  for (const [index, element] of list.entries()) {
    const problem = elementProblem(element);
    if (problem === undefined) {
      continue;
    }
    throw new NoeticConfigError({
      code: 'INVALID_STEP_IN_ARRAY',
      message: `Element ${index} of an array of steps ${problem}.`,
      hint: 'An array of steps holds steps only. Spread a nested array into its parent (`[a, ...rest]`); arrays are not flattened.',
    });
  }
  return frameworkCast<ReadonlyArray<Step<never, never, unknown>>>(list);
}

//#endregion

//#region Public API

/**
 * A step from a step or an array of steps. An array of two or more becomes a
 * `sequence` step whose id joins its children's ids; a one-element array is its
 * element. The sequence holds a frozen copy of the array, so changing the
 * array afterwards changes nothing. Builders that take `Steps` call this, so an
 * array runs in sequence wherever they take a step.
 *
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ARRAY` for an empty array.
 * @throws `NoeticConfigError` with code `INVALID_STEP_IN_ARRAY` when an element
 *   is not a step (a nested array, `null`, or an object without a step kind
 *   and string id). Nested arrays are rejected, not flattened.
 */
export function toStep<TContext = ContextData, I = unknown, O = unknown>(
  steps: Steps<TContext, I, O>,
): Step<TContext, I, O> {
  if (!isStepList(steps)) {
    return frameworkCast<Step<TContext, I, O>>(steps);
  }
  const list = requireSteps(steps);
  const [first] = list;
  if (!first) {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ARRAY',
      message: 'An array of steps must contain at least one step.',
      hint: 'Pass the steps to run in sequence, or a single step.',
    });
  }
  if (list.length === 1) {
    return frameworkCast<Step<TContext, I, O>>(first);
  }
  const children = Object.freeze(
    frameworkCast<Array<Step<TContext, I, O>>>([
      ...list,
    ]),
  );
  return {
    kind: 'sequence',
    id: children.map((child) => child.id).join(' > '),
    steps: children,
  } satisfies StepSequence<TContext, I, O>;
}

//#endregion
