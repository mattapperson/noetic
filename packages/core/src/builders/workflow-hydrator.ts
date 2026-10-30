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
  Context,
  CustomItemMap,
  ExecuteStepFn,
  OutputCodec,
  ProcessSubprocessRequest,
  ServerToolSpec,
  Step,
  SubprocessAdapter,
  Tool,
  ToolContext,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { frameworkCast, isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import type { ExpressionBindings, ExpressionLimits } from '../expression/jsonata';
import { compileExpression, compute, readInput } from '../expression/jsonata';
import { markRecorded, stepOutputsOf } from '../expression/step-outputs';
import type {
  CallModelWorkflowNode,
  OutputCodecRef,
  WorkflowConnectionRef,
  WorkflowDocument,
  WorkflowNode,
  WorkflowStepList,
} from '../schemas/workflow';
import { shorthandStepId, stepEntryToNode, stepListEntries } from '../schemas/workflow';
import { DetachedHandleImpl } from '../util/detached-handle';
import { outputText } from './output-text';
import { callModel, runCode, step } from './step-builders';
import {
  hydrateInParallelNode,
  hydrateSpawnNode,
  hydrateSubflowNode,
  hydrateWithContextNode,
} from './workflow-child-nodes';
import { hydrateCallNode, hydrateWaitNode } from './workflow-connection-nodes';
import type { ConnectionManifestEntries, ConnectionUses } from './workflow-connections';
import { checkDocumentConnections } from './workflow-connections';
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
import { workflowReplayKey } from './workflow-replay-key';
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
   * Resolves a named subprocess adapter ref declared on a `runCode` node's
   * `subprocess` field. When a node omits the ref, the step falls back to
   * `ctx.subprocess` at execution time.
   */
  resolveSubprocess?: (ref: string) => SubprocessAdapter | undefined;
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
   * The hydrated document's identity for `$steps`: each `hydrateWorkflow` call
   * makes a new one, so two documents in one run never read each other's node
   * outputs. Set internally — callers never set it.
   */
  documentScope?: object;
  /**
   * Custom items the nodes being hydrated may emit (spec 34): the enclosing document's
   * root scope. Threaded by `hydrateWorkflow` and the subflow hydrator.
   */
  customItems?: CustomItemMap;
  /**
   * The connections the enclosing document declares (spec 35 § JSON workflows).
   * Threaded by `hydrateWorkflow`; a node naming a connection outside it fails
   * with `CONNECTION_UNKNOWN`. Without a manifest, names pass to the registry as they are.
   */
  connections?: ConnectionManifestEntries;
  /** What the document uses of each connection, for negotiation and gate 1. Threaded by `hydrateWorkflow`. */
  connectionUses?: ConnectionUses;
  /**
   * The connection an operation written by name, or a node without
   * `connection`, runs on: a `verify` subject or a `wait`'s connection. Without
   * one, the document's only connection.
   */
  enclosingConnection?: WorkflowConnectionRef;
  /** The connection name `$item` holds on a fan-out path (an `inParallel` whose `over` lists connections). */
  fanOutItem?: string;
}

type NodeHydrator = (
  node: WorkflowNode,
  ctx: HydrationContext,
) => Step<ContextData, string, string>;

//#endregion

//#region Node Hydrators

/**
 * Resolve an llm node's `tools` entries into a combined client+server list.
 *
 * Every entry is `{ type, parameters? }`. A reserved `openrouter:*` literal is
 * a SERVER tool (flows through unchanged); any other `type` is a CLIENT tool
 * whose `type` is the registered tool NAME (resolved from the registry). Both
 * kinds combine into one `tools` array; the interpreter partitions them again
 * at execution.
 */
function resolveCallModelTools(
  entries: CallModelWorkflowNode['tools'],
  registry: ReadonlyMap<string, Tool>,
): (Tool | ServerToolSpec)[] {
  const toolNames: string[] = [];
  const serverSpecs: ServerToolSpec[] = [];
  for (const entry of entries ?? []) {
    if (isServerToolSpec(entry)) {
      serverSpecs.push(entry);
    } else {
      toolNames.push(entry.type);
    }
  }
  return [
    ...resolveTools(toolNames, registry),
    ...serverSpecs,
  ];
}

function hydrateCallModelNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'callModel') {
    return frameworkCast(undefined);
  }

  const combined = resolveCallModelTools(node.tools, ctx.tools);

  return callModel({
    id: node.id,
    model: node.model ?? 'openai/gpt-4o',
    instructions: node.instructions,
    tools: combined.length > 0 ? combined : undefined,
    toolChoice: node.toolChoice,
    params: node.params,
    output: resolveOutputCodec(node.output, node.id, ctx),
  });
}

/**
 * Resolve a `callModel` node's `output` codec reference to a live `OutputCodec`.
 *
 * Hydrated steps are typed `<string, string>` (the JSON boundary erases output
 * types), so the resolved codec is cast to the step's erased output type — the
 * runtime still returns the codec's real value. This is the same erasure the
 * rest of the hydrator applies via `frameworkCast`.
 */
/** A complete sentence naming what is registered, for a hint. */
function registeredSentence(noun: string, names: Iterable<string>): string {
  const list = [
    ...names,
  ];
  if (list.length === 0) {
    return `No ${noun} are registered.`;
  }
  return `Registered ${noun}: ${list.join(', ')}.`;
}

function resolveOutputCodec(
  ref: OutputCodecRef | undefined,
  nodeId: string,
  ctx: HydrationContext,
): OutputCodec<string> | undefined {
  if (!ref) {
    return undefined;
  }
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

  return frameworkCast(
    runCode({
      id: node.id,
      execute: async (_input: string, execCtx: Context) => {
        const args = node.args ?? {};
        const callId = `call-${node.id}-${Date.now()}`;
        const callItem = {
          id: callId,
          type: 'function_call' as const,
          status: 'completed' as const,
          name: node.toolName,
          callId,
          arguments: JSON.stringify(args),
        };
        execCtx.itemLog.append(callItem);
        const layerState: ToolContext = {
          get: <T>(_layerId: string): T | undefined => undefined,
          set: <T>(_layerId: string, _state: T): void => {},
        };
        const toolCtx: ToolExecutionContext = {
          ctx: execCtx,
          harness: execCtx.harness,
          fs: execCtx.fs,
          shell: execCtx.shell,
          context: layerState,
          assembledView: execCtx.itemLog.items,
          lastStepMeta: execCtx.lastStepMeta,
        };
        const result = await resolved.execute(args, toolCtx);
        return outputText(result);
      },
    }),
  );
}

function hydrateRunCodeNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'runCode') {
    return frameworkCast(undefined);
  }
  const code = node.execute;
  const subprocessRef = node.subprocess;
  return frameworkCast(
    runCode({
      id: node.id,
      retry: node.retry,
      execute: async (input: string, execCtx: Context) => {
        const adapter = resolveSubprocessAdapter({
          ref: subprocessRef,
          hydrationCtx: ctx,
          execCtx,
          nodeId: node.id,
        });
        return runCodeViaSubprocess({
          adapter,
          nodeId: node.id,
          code,
          input: outputText(input),
        });
      },
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

function hydrateAcpAgentNode(
  node: WorkflowNode,
  ctx: HydrationContext,
): Step<ContextData, string, string> {
  if (node.kind !== 'acp-agent') {
    return frameworkCast(undefined);
  }
  const agent = ctx.acpAgents?.get(node.agent);
  if (!agent) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_ACP_AGENT_REFERENCE',
      message: `ACP agent '${node.agent}' referenced in workflow node '${node.id}' is not registered.`,
      hint: 'Pass agent adapters via HydrationContext.acpAgents, e.g. createAcpAgentRegistry(claudeCode()) from @noetic-tools/acp.',
    });
  }
  return step.acpAgent({
    id: node.id,
    agent,
    prompt: node.prompt,
    cwd: node.cwd,
    mode: node.mode,
    model: node.model,
    mcpServers: node.mcpServers,
    permissions: node.permissions,
    clientCapabilities: node.clientCapabilities,
    session: node.session,
  });
}

//#endregion

//#region Document Scope

/** Nodes hydrated outside any `hydrateWorkflow` (a bare `hydrateNode`) share one scope. */
const BARE_DOCUMENT_SCOPE: object = {};

/** The `$steps` scope of the document `ctx` is hydrating. */
export function documentScopeOf(ctx: HydrationContext): object {
  return ctx.documentScope ?? BARE_DOCUMENT_SCOPE;
}

/** The bindings an expression evaluated in `execCtx` sees: `$steps`, and `$item` on a fan-out path. */
export function bindingsFor(execCtx: Context, ctx: HydrationContext): ExpressionBindings {
  return {
    steps: stepOutputsOf(execCtx, documentScopeOf(ctx)),
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
  enclosing?: WorkflowConnectionRef;
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

//#region Helpers

function resolveTools(
  toolNames: string[] | undefined,
  registry: ReadonlyMap<string, Tool>,
): Tool[] {
  if (!toolNames || toolNames.length === 0) {
    return [];
  }
  return toolNames.map((name) => {
    const resolved = registry.get(name);
    if (!resolved) {
      throw new NoeticConfigError({
        code: 'UNKNOWN_TOOL_REFERENCE',
        message: `Tool '${name}' referenced in workflow is not registered.`,
        hint: `Register '${name}' in HydrationContext.tools before hydrating. ${registeredSentence('tools', registry.keys())}`,
      });
    }
    return resolved;
  });
}

//#endregion

//#region Run Node Helpers

/**
 * Resolves the subprocess adapter for a `runCode` node. When the node names an
 * adapter ref, the host must supply a `resolveSubprocess` resolver; otherwise
 * the step falls back to the harness adapter on the execution context.
 */
function resolveSubprocessAdapter(opts: {
  ref: string | undefined;
  hydrationCtx: HydrationContext;
  execCtx: Context;
  nodeId: string;
}): SubprocessAdapter {
  const { ref, hydrationCtx, execCtx, nodeId } = opts;
  if (ref === undefined) {
    return execCtx.subprocess;
  }
  const resolved = hydrationCtx.resolveSubprocess?.(ref);
  if (!resolved) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_SUBPROCESS_REFERENCE',
      message: `Subprocess adapter '${ref}' referenced in run node '${nodeId}' could not be resolved.`,
      hint: 'Pass a `resolveSubprocess(ref)` mapping in the HydrationContext, or omit `subprocess` to use the harness default (ctx.subprocess).',
    });
  }
  return resolved;
}

/**
 * Dispatches a `runCode` node's code string through a subprocess adapter: ships the
 * code plus the JSON-stringified input as a process request (input on stdin),
 * waits for the handle to settle, and returns the captured stdout as the step
 * output. A non-zero exit / failed handle surfaces as a thrown error.
 *
 * The code is never eval'd in-process (Cloudflare Workers forbid eval). The
 * adapter owns running the code and capturing stdout into `handle.metadata.result`.
 */
async function runCodeViaSubprocess(opts: {
  adapter: SubprocessAdapter;
  nodeId: string;
  code: string;
  input: string;
}): Promise<string> {
  const { adapter, nodeId, code, input } = opts;
  const request: ProcessSubprocessRequest = {
    kind: 'process',
    command: 'node',
    args: [
      '-e',
      code,
    ],
    stdin: input,
    metadata: {
      noeticRun: true,
      stepId: nodeId,
      code,
      input,
    },
  };
  const handle = new DetachedHandleImpl<string>({
    id: `run-${nodeId}`,
    stepId: nodeId,
    spawned: adapter.spawn(request),
  });
  const result = await handle.await();
  return outputText(result);
}

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
  // Set in place rather than copied: builders register the step object itself.
  if (node.durable !== undefined) {
    hydrated.durable = node.durable;
  }
  if (node.replayKey !== undefined) {
    hydrated.replayKey = workflowReplayKey(node.id, node.replayKey);
  }
  const scope = nodeScope(node, ctx.customItems);
  if (Object.keys(scope).length > 0) {
    hydrated.customItems = scope;
  }
  if (node.emitItems !== undefined) {
    hydrated.emitItems = hydrateEmitItems({
      nodeId: node.id,
      option: node.emitItems,
      scope,
      limits: ctx.expressionLimits,
    });
  }
  return hydrated;
}

/**
 * Hydrates a complete `WorkflowDocument` into a live `Step` tree.
 *
 * @public
 * @param doc - Validated workflow document (version 1).
 * @param ctx - Hydration context with tool registry and step executor.
 * @param customItems - TypeScript declarations of the document's root custom items (spec 34).
 * @returns The root `Step` of the hydrated workflow.
 * @throws `NoeticConfigError` with code `CUSTOM_ITEM_MISMATCH` when `customItems` and the document give one name different types.
 * @throws `NoeticConfigError` with code `CONNECTION_UNKNOWN` when a node uses a connection the document's `connections` do not declare, or `CONNECTION_INVALID` when a node's connection is neither named nor implied, or a source entry is used beyond its events.
 */
export function hydrateWorkflow(
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
  return root;
}

//#endregion
