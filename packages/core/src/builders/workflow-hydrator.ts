/**
 * Converts a validated `WorkflowDocument` into a live `Step` tree.
 *
 * Each node kind maps to the corresponding builder (`callModel`, `inParallel`,
 * `loop`, etc.) so hydrated steps are indistinguishable from programmatic
 * ones — they register in the step registry, carry retry policies, etc.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpAllowlist,
  ConnectionAllowlist,
  Context,
  CustomItemMap,
  ExecuteStepFn,
  McpAllowlist,
  OutputCodec,
  RunCodeGrant,
  StandardSchemaV1,
  Step,
  StepEmitItemsResult,
  SubprocessAdapter,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import type { ExpressionBindings, ExpressionLimits } from '../expression/jsonata';
import { compileExpression, compute, readInput } from '../expression/jsonata';
import { loopRunsOf, markRecorded, stepOutputsOf } from '../expression/step-outputs';
import type {
  OutputCodecRef,
  WorkflowArgs,
  WorkflowConnectionRef,
  WorkflowDocument,
  WorkflowNode,
  WorkflowOutputSchema,
  WorkflowStepList,
} from '../schemas/workflow';
import { shorthandStepId, stepEntryToNode, stepListEntries } from '../schemas/workflow';
import { outputText } from './output-text';
import { callModel, invokeTool, runCode } from './step-builders';
import {
  hydrateInParallelNode,
  hydrateSpawnNode,
  hydrateSubflowNode,
  hydrateWithContextNode,
} from './workflow-child-nodes';
import {
  hydrateAcpAgentNode,
  hydrateCallNode,
  hydrateRunCodeNode,
  hydrateWaitNode,
} from './workflow-connection-nodes';
import type { ConnectionManifestEntries, ConnectionUses } from './workflow-connections';
import { checkDocumentConnections, compileArgs } from './workflow-connections';
import {
  hydrateConditionalNode,
  hydrateDecideNode,
  hydrateLoopNode,
  hydrateRouteSwitchNode,
  hydrateScheduleNode,
} from './workflow-control-nodes';
import {
  documentScope,
  everyDocumentItem,
  hydrateEmitItems,
  nodeScope,
} from './workflow-custom-items';
import { outputSchemaOf } from './workflow-output';
import type { ParamUse } from './workflow-params';
import {
  emitOption,
  fromParam,
  fromParamSync,
  lazyOption,
  paramFor,
  paramFunction,
} from './workflow-params';
import { workflowReplayKey } from './workflow-replay-key';
import {
  nodeTools,
  recordDocumentConnections,
  registeredSentence,
  withCeiling,
} from './workflow-tool-entries';
import { hydrateVerifyNode } from './workflow-verify';

//#region Types

/** @public Context required to hydrate a JSON workflow into live steps. */
export interface HydrationContext {
  tools: ReadonlyMap<string, Tool>;
  executeStep: ExecuteStepFn;
  layers?: ReadonlyMap<string, ContextLayer>;
  /**
   * ACP agent adapters keyed by `agentId`, resolving an `acp-agent` node's
   * `agent` field. An OPEN registry — supporting a new agent needs no schema
   * change, only another entry here.
   */
  acpAgents?: ReadonlyMap<string, AcpAgent>;
  /**
   * Output codecs keyed by the `library` ref a `callModel` node's `output` codec
   * reference names — the live codec built from a component library, e.g.
   * `new Map([['dashboard-lib', openUi(dashboardLibrary)]])` from
   * `@noetic-tools/openui`. Resolved the same way ACP agent adapters are.
   */
  uiLibraries?: ReadonlyMap<string, OutputCodec>;
  /**
   * Resolves the name a `runCode` or `spawn` node's `subprocess` field gives.
   * For a `runCode` node that carries code, a name it does not know is looked
   * up among the harness's subprocess adapters, when `runCodeBounds` allows
   * it; a `spawn` node, and a `runCode` node whose `execute` is a function,
   * resolve here alone, when the document hydrates. A node that names none
   * runs through `ctx.subprocess`.
   */
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
  /**
   * What `runCode` nodes are held to when the host did not write the
   * document: the harness subprocess adapters they may name. Set by
   * `parseAndRunWorkflow` and `dynamicWorkflow`, dropped for named subflow
   * refs, which the host wrote. Callers never set it.
   */
  runCodeBounds?: RunCodeGrant;
  /**
   * Named sub-workflow documents that `subflow` nodes resolve via `ref`.
   * Resolution is lazy (first execution), so a live map view may gain
   * entries after hydration.
   */
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  /**
   * Deepest allowed chain of named-ref resolutions on one execution path.
   * Positive integer or `Infinity`. Default: 100.
   */
  maxRecursionDepth?: number;
  /**
   * Named-ref resolutions above the node being hydrated. Threaded internally
   * by the subflow hydrator — callers never set it.
   */
  recursionDepth?: number;
  /** Bounds on each expression evaluation; unset fields use `DEFAULT_EXPRESSION_LIMITS`. */
  expressionLimits?: ExpressionLimits;
  /**
   * What `acp-agent` nodes are held to when the host did not write the
   * document: set by `parseAndRunWorkflow` and `dynamicWorkflow`, dropped for
   * named subflow refs, which the host wrote. Callers never set it.
   */
  acpBounds?: {
    readonly grants: AcpAllowlist;
    /** Prefixes every `session.reuse` key, so the document's sessions never meet the host's. */
    readonly sessionScope: string;
    /** The harness's working directory when the document was checked: a node's `cwd` when neither it nor its grant sets one. */
    readonly cwd: string;
  };
  /**
   * The hydrated document's identity for `$steps`: each `hydrateDocument` call
   * makes a new one, so two documents in one run never read each other's node
   * outputs. Set internally — callers never set it.
   */
  documentScope?: object;
  /**
   * Custom items the nodes being hydrated may emit (spec 34): the enclosing document's
   * root scope. Threaded by `hydrateDocument` and the subflow hydrator.
   */
  customItems?: CustomItemMap;
  /**
   * The connections the enclosing document declares (spec 35 § JSON workflows).
   * Threaded by `hydrateDocument`; a node naming a connection outside it fails
   * with `CONNECTION_UNKNOWN`. Without a manifest, names pass to the registry as they are.
   */
  connections?: ConnectionManifestEntries;
  /** What the document uses of each connection, for negotiation and gate 1. Threaded by `hydrateDocument`. */
  connectionUses?: ConnectionUses;
  /**
   * The connection an operation written by name, or a node without
   * `connection`, runs on: a `verify` subject or a `wait`'s connection. Without
   * one, the document's only connection.
   */
  enclosingConnection?: ConnectionRef;
  /**
   * What the ids of the nodes being hydrated carry beyond the ids the document
   * wrote: a subflow's or a fan-out item's suffix. Set internally.
   */
  idSuffix?: string;
  /** The connection name `$item` holds on a fan-out path (an `inParallel` whose `over` lists connections). */
  fanOutItem?: string;
  /**
   * What the document may use of each connection. A `{ "connection" }` tool
   * entry is narrowed to the operations it grants. Absent allows every
   * connection the harness or the turn holds.
   */
  allowlist?: ConnectionAllowlist;
  /**
   * The MCP servers the document may name (spec 26 § MCP servers): its
   * `{ "mcp" }` entries, in `tools` or `connections`. Absent grants none.
   */
  mcp?: McpAllowlist;
}

/** The connection a node runs on, as hydration reads it: a name, an expression, or a param that gives the name. */
export type ConnectionRef = WorkflowConnectionRef | ParamUse;

type NodeHydrator = (
  node: WorkflowNode,
  ctx: HydrationContext,
) => Step<ContextData, string, string>;

//#endregion

//#region Node Hydrators

/**
 * The model a `callModel` node runs on when neither it nor the harness names
 * one, and the `dynamicWorkflow` planner's under the same conditions.
 */
export const FALLBACK_MODEL = 'openai/gpt-4o';

function hydrateCallModelNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'callModel') {
    return frameworkCast(undefined);
  }

  return withCeiling(
    callModel({
      id: node.id,
      model: lazyOption<string | undefined>(
        node,
        'model',
        node.model ?? ((execCtx: Context) => execCtx.harness.config.model ?? FALLBACK_MODEL),
      ),
      instructions: lazyOption(node, 'instructions', node.instructions),
      tools: lazyOption(node, 'tools', nodeTools(node, ctx)),
      toolChoice: node.toolChoice,
      params: node.params,
      output: resolveOutput(node.output, node.id, ctx),
      // The model is sent the schema as the document wrote it.
      outputJsonSchema: node.output && 'schema' in node.output ? node.output.schema : undefined,
      // A document the host did not write cannot hide its model calls from the stream.
      emit: ctx.acpBounds ? undefined : emitOption(node),
      projection: node.projection,
    }),
    node,
    ctx,
  );
}

/**
 * Resolve a `callModel` node's `output`: an inline JSON Schema to a validator,
 * a codec reference to a live `OutputCodec`.
 *
 * Hydrated steps are typed `<string, string>` (the JSON boundary erases output
 * types), so the result is cast to the step's erased output type — the
 * runtime still returns the parsed value. This is the same erasure the
 * rest of the hydrator applies via `frameworkCast`.
 *
 * @throws `NoeticConfigError` `INVALID_OUTPUT_SCHEMA` when the JSON Schema does not load, `UNKNOWN_UI_LIBRARY_REFERENCE` when the codec's library is not registered.
 */
function resolveOutput(
  output: WorkflowOutputSchema | OutputCodecRef | undefined,
  nodeId: string,
  ctx: HydrationContext,
): StandardSchemaV1<unknown, string> | OutputCodec<string> | undefined {
  if (!output) {
    return undefined;
  }
  return 'schema' in output
    ? frameworkCast(outputSchemaOf(output.schema, nodeId))
    : resolveOutputCodec(output, nodeId, ctx);
}

function resolveOutputCodec(
  ref: OutputCodecRef,
  nodeId: string,
  ctx: HydrationContext,
): OutputCodec<string> {
  const codec = ctx.uiLibraries?.get(ref.library);
  if (codec) {
    return frameworkCast<OutputCodec<string>>(codec);
  }
  throw new NoeticConfigError({
    code: 'UNKNOWN_UI_LIBRARY_REFERENCE',
    message: `UI library '${ref.library}' referenced in workflow node '${nodeId}' is not registered.`,
    hint: `Pass output codecs via HydrationContext.uiLibraries, e.g. new Map([['${ref.library}', openUi(myLibrary)]]) from @noetic-tools/openui. ${registeredSentence('UI libraries', ctx.uiLibraries?.keys() ?? [])}`,
  });
}

function hydrateInvokeToolNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'invokeTool') {
    return frameworkCast(undefined);
  }

  const resolved = ctx.tools.get(node.toolName);
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_TOOL_REFERENCE',
      message: `Tool '${node.toolName}' referenced in workflow node '${node.id}' is not registered.`,
      hint: `Register '${node.toolName}' in HydrationContext.tools before hydrating. ${registeredSentence('tools', ctx.tools.keys())}`,
    });
  }

  const args = compileArgs(
    frameworkCast<WorkflowArgs>(node.args),
    `args of invokeTool node '${node.id}'`,
    ctx.expressionLimits,
  );
  const param = paramFor(node, 'args');

  return frameworkCast(
    invokeTool({
      id: node.id,
      tool: resolved,
      args: (input: unknown, execCtx: Context) =>
        param
          ? fromParam(execCtx, param, [
              input,
              execCtx,
            ])
          : args(readInput(input), bindingsFor(execCtx, ctx)),
    }),
  );
}

function hydrateComputeNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'compute') {
    return frameworkCast(undefined);
  }
  const expr = compileExpression(node.expr, `compute node '${node.id}'`, ctx.expressionLimits);
  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) =>
        outputText(await compute(expr, readInput(input), bindingsFor(execCtx, ctx))),
    }),
  );
}

function hydrateSequenceNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'sequence') {
    return frameworkCast(undefined);
  }

  const children = node.steps.map((s, i) =>
    hydrateNode(stepEntryToNode(s, shorthandStepId(node.id, i)), ctx),
  );

  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (input: string, execCtx: Context) => {
        let current: unknown = input;
        for (const child of children) {
          const childInput = outputText(current);
          current = await ctx.executeStep(child, childInput, execCtx);
        }
        return outputText(current);
      },
    }),
  );
}

//#endregion

//#region Document Scope

/** Nodes hydrated outside any `hydrateDocument` (a bare `hydrateNode`) share one scope. */
const BARE_DOCUMENT_SCOPE: object = {};

/** The `$steps` scope of the document `ctx` is hydrating. */
export function documentScopeOf(ctx: HydrationContext): object {
  return ctx.documentScope ?? BARE_DOCUMENT_SCOPE;
}

/** The bindings an expression evaluated in `execCtx` sees: `$steps`, `$runs`, and `$item` on a fan-out path. */
export function bindingsFor(execCtx: Context, ctx: HydrationContext): ExpressionBindings {
  return {
    steps: stepOutputsOf(execCtx, documentScopeOf(ctx)),
    runs: loopRunsOf(execCtx, documentScopeOf(ctx)),
    ...(ctx.fanOutItem === undefined
      ? {}
      : {
          item: ctx.fanOutItem,
        }),
  };
}

/**
 * Hydrates a step list (`around`, `act`, a sequence's steps): each entry a node,
 * or an operation written by name that becomes a `call` with id `<parentId>[i]`
 * on `enclosing` (when given).
 *
 * @public
 */
export function hydrateStepList(opts: {
  list: WorkflowStepList;
  parentId: string;
  ctx: HydrationContext;
  enclosing?: ConnectionRef;
}): Step<ContextData, string, unknown>[] {
  const { list, parentId, ctx, enclosing } = opts;
  const childCtx: HydrationContext =
    enclosing === undefined
      ? ctx
      : {
          ...ctx,
          enclosingConnection: enclosing,
        };
  return stepListEntries(list).map((entry, i) =>
    frameworkCast<Step<ContextData, string, unknown>>(
      hydrateNode(stepEntryToNode(entry, shorthandStepId(parentId, i)), childCtx),
    ),
  );
}

//#endregion

//#region Handler Registry

const NODE_HYDRATORS: Record<string, NodeHydrator> = {
  callModel: hydrateCallModelNode,
  invokeTool: hydrateInvokeToolNode,
  runCode: hydrateRunCodeNode,
  compute: hydrateComputeNode,
  conditional: hydrateConditionalNode,
  decide: hydrateDecideNode,
  routeSwitch: hydrateRouteSwitchNode,
  inParallel: hydrateInParallelNode,
  spawn: hydrateSpawnNode,
  withContext: hydrateWithContextNode,
  loop: hydrateLoopNode,
  sequence: hydrateSequenceNode,
  schedule: hydrateScheduleNode,
  subflow: hydrateSubflowNode,
  'acp-agent': hydrateAcpAgentNode,
  call: hydrateCallNode,
  wait: hydrateWaitNode,
  // Owned by the verification slice (spec 37); it hydrates `act` through `hydrateStepList`.
  verify: hydrateVerifyNode,
};

//#endregion

//#region Public API

/**
 * Hydrates a single `WorkflowNode` into a live `Step`.
 *
 * @public
 * @param node - Validated workflow node.
 * @param ctx - Hydration context with tool registry and step executor.
 * @returns A live `Step` ready for execution.
 * @throws `NoeticConfigError` with code `UNKNOWN_NODE_KIND` if the node kind is unrecognised.
 * @throws `NoeticConfigError` with code `UNKNOWN_TOOL_REFERENCE` if a tool name cannot be resolved.
 * @throws `NoeticConfigError` with code `INVALID_OUTPUT_SCHEMA` if a `callModel` node's `output.schema` is not a JSON Schema that loads.
 * @throws `NoeticConfigError` with code `UNKNOWN_UNTIL_PREDICATE` if an until predicate kind is unrecognised.
 * @throws `NoeticConfigError` with code `INVALID_UNTIL_DECIDER` if a decide until predicate does not ask exactly one boolean question.
 * @throws `NoeticConfigError` with code `UNKNOWN_WORKFLOW_REFERENCE` (at execution time) if a subflow ref names no registered workflow.
 * @throws `NoeticConfigError` with code `WORKFLOW_RECURSION_LIMIT` (at execution time) if named sub-workflow refs nest deeper than `maxRecursionDepth`.
 * @throws `NoeticConfigError` with code `INVALID_MAX_RECURSION_DEPTH` (at execution time) when a named ref resolves under a `maxRecursionDepth` that is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` if a `compute` expression, a conditional route's `expr`, an `expr` until predicate, or an `emitItems` expression does not parse.
 * @throws `NoeticConfigError` with code `INVALID_EXPRESSION_LIMITS` if an expression compiles under `expressionLimits` holding a value that is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `EXPRESSION_FAILED` or `EXPRESSION_LIMIT_EXCEEDED` (at execution time) if an expression fails or exceeds its limits.
 */
export function hydrateNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  const hydrator = NODE_HYDRATORS[node.kind];
  if (!hydrator) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_NODE_KIND',
      message: `Unknown workflow node kind: '${node.kind}'.`,
      hint: `Supported kinds: ${Object.keys(NODE_HYDRATORS).join(', ')}.`,
    });
  }
  const hydrated = hydrator(node, ctx);
  // Its output becomes `$steps.<id>` for later expressions of its document once it completes.
  markRecorded(hydrated, documentScopeOf(ctx));
  setReplay(hydrated, node);
  setEmitItems(hydrated, node, ctx);
  return hydrated;
}

/** Sets a node's replay options on its step, in place: builders register the step object itself. */
function setReplay(hydrated: Step<ContextData, string, string>, node: WorkflowNode): void {
  if (node.durable !== undefined) {
    hydrated.durable = node.durable;
  }
  if (node.replayKey !== undefined) {
    hydrated.replayKey = workflowReplayKey(node.id, node.replayKey);
  }
  if (node.execution !== undefined) {
    const { durable, replayKey, retry } = node.execution;
    hydrated.execution = {
      durable,
      replayKey: replayKey === undefined ? undefined : workflowReplayKey(node.id, replayKey),
      retry,
    };
  }
  const replayKey = paramFor(node, 'replayKey');
  if (replayKey) {
    hydrated.replayKey = (input, execCtx) =>
      String(
        fromParamSync(execCtx, replayKey, [
          input,
          execCtx,
        ]),
      );
  }
}

/** Sets what a node emits, and the custom items it may emit, on its step. */
function setEmitItems(
  hydrated: Step<ContextData, string, string>,
  node: WorkflowNode,
  ctx: HydrationContext,
): void {
  const scope = nodeScope(node, ctx.customItems);
  if (Object.keys(scope).length > 0) {
    hydrated.customItems = scope;
  }
  const emitItems = paramFor(node, 'emitItems');
  if (emitItems) {
    hydrated.emitItems = (output: unknown, execCtx: Context) =>
      frameworkCast<StepEmitItemsResult>(paramFunction(execCtx, emitItems)(output, execCtx));
  }
  const hooks = {
    onStart: paramFor(node, 'onStart'),
    onDone: paramFor(node, 'onDone'),
  };
  if (node.emitItems === undefined && !hooks.onStart && !hooks.onDone) {
    return;
  }
  hydrated.emitItems = hydrateEmitItems({
    nodeId: node.id,
    option: node.emitItems ?? {},
    scope,
    limits: ctx.expressionLimits,
    hooks,
    bindings: (execCtx) => bindingsFor(execCtx, ctx),
  });
}

/**
 * @internal
 * Hydrates a complete `WorkflowDocument` into a live `Step` tree. The root holds
 * no source: `hydrateWorkflow` gives a host one a harness can store, and a step
 * that hydrates as it runs needs none.
 *
 * @throws `NoeticConfigError` with code `CUSTOM_ITEM_MISMATCH` when `customItems` and the document give one name different types.
 * @throws `NoeticConfigError` with code `CONNECTION_UNKNOWN` when a node uses a connection the document's `connections` do not declare, or `CONNECTION_INVALID` when a node's connection is neither named nor implied, or a source entry is used beyond its events.
 */
export function hydrateDocument(
  doc: WorkflowDocument,
  ctx: HydrationContext,
  customItems?: CustomItemMap,
): Step<ContextData, string, string> {
  const connectionUses = checkDocumentConnections(doc);
  const root = hydrateNode(doc.root, {
    ...ctx,
    documentScope: {},
    customItems: documentScope(doc, ctx.customItems, customItems),
    connections: doc.connections ?? {},
    connectionUses,
  });
  // The root's dispatch accepts every item the document declares before anything
  // runs or replays; keyed by type, they cannot shadow the root's own names.
  root.customItems = {
    ...everyDocumentItem(doc),
    ...root.customItems,
  };
  recordDocumentConnections(frameworkCast<Step>(root), doc, ctx.mcp);
  return root;
}

//#endregion
