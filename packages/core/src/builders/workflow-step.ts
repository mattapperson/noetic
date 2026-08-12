/**
 * `workflow` — runs a `WorkflowDocument` as a single composable step.
 *
 * Lives beside `step-builders.ts` (rather than inside it) because the hydrator
 * imports the base builders; adding a hydrating builder there would create an
 * import cycle.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  Context,
  ExecuteStepFn,
  OutputCodec,
  Step,
  StepRunCode,
  SubHarness,
  SubHarnessKind,
  SubprocessAdapter,
  Tool,
  WorkflowDocument,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { spawn } from './spawn-builder';
import { runCode } from './step-builders';
import type { HydrationContext } from './workflow-hydrator';
import { hydrateWorkflow } from './workflow-hydrator';

//#region Types

/** @public Options for `workflow`. */
export interface WorkflowOpts {
  id: string;
  /** Inline workflow document. Mutually exclusive with `ref`. */
  document?: WorkflowDocument;
  /** Named workflow resolved from `workflows`. Mutually exclusive with `document`. */
  ref?: string;
  /** Client tools the document's `callModel`/`invokeTool` nodes may reference by name. Default: none. */
  tools?: Tool[];
  /** Named context layers for `withContext`/`spawn` nodes. */
  layers?: ReadonlyMap<string, ContextLayer>;
  /** Named sub-workflows for `subflow` nodes — and for resolving `ref` itself. */
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  /** SubHarness adapters for `claude-code`/`codex`/`opencode`/`pi` nodes. */
  subHarnesses?: ReadonlyMap<SubHarnessKind, SubHarness>;
  /** Output codecs for `callModel` nodes' `output` codec references. */
  uiLibraries?: ReadonlyMap<string, OutputCodec>;
  /** Resolver for named subprocess adapters on `runCode` nodes. */
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
  /** `'inherit'` (default) runs in the caller's session; `'spawn'` isolates via `spawn()`. */
  isolation?: 'inherit' | 'spawn';
}

//#endregion

//#region Builder

/**
 * Creates a step that hydrates and executes a JSON workflow document.
 *
 * The document resolves lazily on first execution (so a `ref` may target a
 * workflow registered after the step is built) and the hydrated tree is
 * memoized across executions. When the step itself is built from a `ref`,
 * that name seeds the subflow ancestry chain, so a self-referencing named
 * workflow fails with `WORKFLOW_CYCLE` instead of recursing forever.
 *
 * @public
 * @param opts - See `WorkflowOpts`.
 * @returns A `StepRunCode` executing the workflow via the harness on the context.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `INVALID_WORKFLOW_SOURCE` unless exactly one of `document`/`ref` is set.
 * @throws `NoeticConfigError` with code `MISSING_HARNESS_CONTEXT` (at execution) without `ctx.harness`.
 * @throws `NoeticConfigError` with code `UNKNOWN_WORKFLOW_REFERENCE` (at execution) if `ref` names no registered workflow.
 */
export function workflow(opts: WorkflowOpts): StepRunCode<ContextData, string, string> {
  if (!opts.id || opts.id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: 'workflow() requires a non-empty id.',
      hint: 'Pass a unique string as the id field, e.g. workflow({ id: "verify", ... }).',
    });
  }
  if ((opts.document === undefined) === (opts.ref === undefined)) {
    throw new NoeticConfigError({
      code: 'INVALID_WORKFLOW_SOURCE',
      message: `workflow('${opts.id}') requires exactly one of 'document' (inline) or 'ref' (named).`,
      hint: "Pass document: { version: 1, root: ... } or ref: '<name>' with a workflows registry.",
    });
  }

  // The hydrated tree bakes the harness's executeStep into every nested
  // node's closure, so the cache is keyed on the harness: a step shared
  // across sessions re-hydrates when it runs under a different harness
  // instead of routing nested steps through the first one.
  let cached:
    | {
        harness: unknown;
        step: Step<ContextData, string, string>;
      }
    | undefined;

  return runCode({
    id: opts.id,
    execute: async (input: string, ctx: Context): Promise<string> => {
      const harness = ctx.harness;
      if (!harness) {
        throw new NoeticConfigError({
          code: 'MISSING_HARNESS_CONTEXT',
          message: 'workflow requires a harness on the execution context.',
          hint: 'Execute this step via AgentHarness.run() or ensure ctx.harness is set.',
        });
      }
      const executeStep: ExecuteStepFn = frameworkCast(harness.run.bind(harness));
      if (!cached || cached.harness !== harness) {
        cached = {
          harness,
          step: hydrate(opts, executeStep),
        };
      }
      return stringify(await executeStep(cached.step, input, ctx));
    },
  });
}

//#endregion

//#region Helpers

function hydrate(
  opts: WorkflowOpts,
  executeStep: ExecuteStepFn,
): Step<ContextData, string, string> {
  const doc = opts.document ?? (opts.ref ? opts.workflows?.get(opts.ref) : undefined);
  if (!doc) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_WORKFLOW_REFERENCE',
      message: `Workflow '${opts.ref}' referenced by workflow('${opts.id}') is not registered.`,
      hint: `Pass named workflows via the workflows option. Available: ${
        [
          ...(opts.workflows?.keys() ?? []),
        ].join(', ') || '(none)'
      }.`,
    });
  }
  const hydrationCtx: HydrationContext = {
    tools: new Map(
      (opts.tools ?? []).map((t) => [
        t.name,
        t,
      ]),
    ),
    executeStep,
    layers: opts.layers,
    workflows: opts.workflows,
    subHarnesses: opts.subHarnesses,
    uiLibraries: opts.uiLibraries,
    resolveSubprocess: opts.resolveSubprocess,
    subflowAncestry: opts.ref
      ? new Set([
          opts.ref,
        ])
      : undefined,
  };
  const hydrated = hydrateWorkflow(doc, hydrationCtx);
  if (opts.isolation !== 'spawn') {
    return hydrated;
  }
  return spawn({
    id: `${opts.id}-spawn`,
    child: hydrated,
  });
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

//#endregion
