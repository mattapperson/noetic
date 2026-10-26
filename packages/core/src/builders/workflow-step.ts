/**
 * `workflow` — runs a `WorkflowDocument` as a single composable step.
 *
 * Lives beside `step-builders.ts` (rather than inside it) because the hydrator
 * imports the base builders; adding a hydrating builder there would create an
 * import cycle.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  AcpAgent,
  Context,
  CustomItemMap,
  CustomItemsBrand,
  DeepReadonly,
  DocumentCustomItems,
  ExecuteStepFn,
  OutputCodec,
  Step,
  StepRunCode,
  SubprocessAdapter,
  Tool,
  WorkflowDocument,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type { ExpressionLimits } from '../expression/jsonata';
import { outputText } from './output-text';
import { spawn } from './spawn-builder';
import { runCode } from './step-builders';
import { everyDocumentItem } from './workflow-custom-items';
import type { HydrationContext } from './workflow-hydrator';
import { hydrateWorkflow } from './workflow-hydrator';

//#region Types

/** @public Options for `workflow`. */
export interface WorkflowOpts<
  D extends WorkflowDocumentInput = WorkflowDocumentInput,
  M extends CustomItemMap = CustomItemMap,
> {
  id: string;
  /**
   * Inline workflow document. Mutually exclusive with `ref`. Written `as const`, its
   * declared custom items type the step (spec 34 § Typing the harness).
   */
  document?: D;
  /**
   * Custom items any node in the document may emit, in TypeScript. A name the document
   * also declares must carry the same `type`; this declaration then validates and types
   * it.
   */
  customItems?: M;
  /** Named workflow resolved from `workflows`. Mutually exclusive with `document`. */
  ref?: string;
  /** Client tools the document's `callModel`/`invokeTool` nodes may reference by name. Default: none. */
  tools?: Tool[];
  /** Named context layers for `withContext`/`spawn` nodes. */
  layers?: ReadonlyMap<string, ContextLayer>;
  /** Named sub-workflows for `subflow` nodes — and for resolving `ref` itself. */
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  /** Deepest allowed chain of named-ref resolutions (`ref` itself included). Positive integer or `Infinity`. Default: 100. */
  maxRecursionDepth?: number;
  /** Bounds on each expression evaluation; unset fields use `DEFAULT_EXPRESSION_LIMITS`. */
  expressionLimits?: ExpressionLimits;
  /** ACP agent adapters, keyed by `agentId`, for `acp-agent` nodes. */
  acpAgents?: ReadonlyMap<string, AcpAgent>;
  /** Output codecs for `callModel` nodes' `output` codec references. */
  uiLibraries?: ReadonlyMap<string, OutputCodec>;
  /** Resolver for named subprocess adapters on `runCode` nodes. */
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
  /** `'inherit'` (default) runs in the caller's session; `'spawn'` isolates via `spawn()`. */
  isolation?: 'inherit' | 'spawn';
}

/** @public A workflow document as `workflow()` takes it: plain, or `as const`. */
export type WorkflowDocumentInput = WorkflowDocument | DeepReadonly<WorkflowDocument>;

/**
 * @public
 * The step `workflow()` returns, branded with the custom items it may emit: its
 * TypeScript map plus those an `as const` document declares. `AgentHarness` reads the
 * brand off `agentGraph` to type its results.
 */
export type TypedWorkflowStep<D, M extends CustomItemMap> = StepRunCode<
  ContextData,
  string,
  string
> &
  CustomItemsBrand<M[keyof M] | DocumentCustomItems<D>>;

//#endregion

//#region Builder

/**
 * Creates a step that hydrates and executes a JSON workflow document.
 *
 * The document resolves lazily on first execution (so a `ref` may target a
 * workflow registered after the step is built) and the hydrated tree is
 * memoized across executions. Named workflows may recurse; when the step
 * itself is built from a `ref`, that ref counts as the first resolution
 * toward `maxRecursionDepth`.
 *
 * @public
 * @param opts - See `WorkflowOpts`.
 * @returns A `StepRunCode` executing the workflow via the harness on the context.
 * @throws `NoeticConfigError` with code `EMPTY_STEP_ID` if `id` is empty.
 * @throws `NoeticConfigError` with code `INVALID_WORKFLOW_SOURCE` unless exactly one of `document`/`ref` is set.
 * @throws `NoeticConfigError` with code `MISSING_HARNESS_CONTEXT` (at execution) without `ctx.harness`.
 * @throws `NoeticConfigError` with code `UNKNOWN_WORKFLOW_REFERENCE` (at execution) if `ref` names no registered workflow.
 * @throws `NoeticConfigError` with code `WORKFLOW_RECURSION_LIMIT` (at execution) if named refs nest deeper than `maxRecursionDepth`.
 * @throws `NoeticConfigError` with code `INVALID_MAX_RECURSION_DEPTH` (at execution) if a nested ref resolves under an invalid `maxRecursionDepth`.
 */
export function workflow<
  const D extends WorkflowDocumentInput = WorkflowDocument,
  const M extends CustomItemMap = Record<never, never>,
>(opts: WorkflowOpts<D, M>): TypedWorkflowStep<D, M> {
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

  const step = runCode({
    id: opts.id,
    customItems: workflowItems(opts),
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
      return outputText(await executeStep(cached.step, input, ctx));
    },
  });
  return frameworkCast<TypedWorkflowStep<D, M>>(step);
}

//#endregion

//#region Helpers

/**
 * Every custom item the workflow can emit, keyed by `type`: its TypeScript map and all
 * the document declares at any level. The step carries them so a harness accepts them
 * in a log before any node runs.
 */
function workflowItems(opts: WorkflowOpts): CustomItemMap {
  const doc = documentOf(opts);
  const found = [
    ...Object.values(doc ? everyDocumentItem(doc) : {}),
    ...Object.values(opts.customItems ?? {}),
  ];
  return Object.fromEntries(
    found.map((item) => [
      item.type,
      item,
    ]),
  );
}

function documentOf(opts: WorkflowOpts): WorkflowDocument | undefined {
  const doc = opts.document ?? (opts.ref ? opts.workflows?.get(opts.ref) : undefined);
  return frameworkCast<WorkflowDocument | undefined>(doc);
}

function hydrate(
  opts: WorkflowOpts,
  executeStep: ExecuteStepFn,
): Step<ContextData, string, string> {
  const doc = documentOf(opts);
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
    acpAgents: opts.acpAgents,
    uiLibraries: opts.uiLibraries,
    resolveSubprocess: opts.resolveSubprocess,
    maxRecursionDepth: opts.maxRecursionDepth,
    expressionLimits: opts.expressionLimits,
    recursionDepth: opts.ref ? 1 : undefined,
  };
  const hydrated = hydrateWorkflow(doc, hydrationCtx, opts.customItems);
  if (opts.isolation !== 'spawn') {
    return hydrated;
  }
  return spawn({
    id: `${opts.id}-spawn`,
    child: hydrated,
  });
}

//#endregion
