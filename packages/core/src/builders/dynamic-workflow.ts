/**
 * Pattern that lets an LLM generate a workflow as JSON during execution,
 * then hydrates and runs it within the same harness session.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { exportSpans } from '@noetic-tools/context';
import type {
  AcpAgent,
  AcpAllowlist,
  AgentHarnessContract,
  ConnectionAllowlist,
  Context,
  ExecuteStepFn,
  McpAllowlist,
  SecretResolver,
  Span,
  Step,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, NoeticConfigError } from '@noetic-tools/types';
import { expressionErrors } from '../expression/check';
import type { ExpressionLimits } from '../expression/jsonata';
import { NoeticAttr } from '../observability/genai-attributes';
import type { WorkflowDocument } from '../schemas/workflow';
import { WorkflowDocumentSchema, workflowDepth, workflowGraph } from '../schemas/workflow';
import { harnessInternal } from '../util/harness-internals';
import { rootOf } from '../util/root-context';
import { outputText } from './output-text';
import { callModel, runCode } from './step-builders';
import { acpBounds, acpPrompt, checkAcpAgents } from './workflow-acp-grants';
import { checkConnectionAllowlist, globMatches } from './workflow-connections';
import type { HydrationContext } from './workflow-hydrator';
import { hydrateWorkflow } from './workflow-hydrator';
import { checkMcpServers, mcpPrompt } from './workflow-mcp-servers';
import { checkToolConnections } from './workflow-tool-entries';

//#region Types

/** @public Options for creating a dynamic workflow step. */
export interface DynamicWorkflowOpts {
  model?: string;
  instructions?: string;
  tools: Tool[];
  maxDepth?: number;
  maxRevisions?: number;
  /** Bounds on each expression evaluation; unset fields use `DEFAULT_EXPRESSION_LIMITS`. */
  expressionLimits?: ExpressionLimits;
  /**
   * What a generated document may use of the harness's connections (spec 35 §
   * What a document may use). Absent grants none, like `{}`: a document asking
   * for a connection fails validation with `CONNECTION_NOT_ALLOWED`, and a
   * node with no `tools` gets only the granted connections. The planner is
   * shown only these connections.
   */
  connections?: ConnectionAllowlist;
  /** ACP agent adapters, keyed by `agentId`, that the document's `acp-agent` nodes may run. Default: none. */
  acpAgents?: ReadonlyMap<string, AcpAgent>;
  /**
   * The most a generated `acp-agent` node may ask of each agent: permissions,
   * `cwd`, client capabilities and sessions (spec 26 § ACP agents). An agent
   * without an entry gets the narrowest defaults; a node asking for more fails
   * validation with `CONNECTION_NOT_ALLOWED`. The planner is shown these limits.
   */
  acp?: AcpAllowlist;
  /**
   * The MCP servers a generated document may attach — `{ "mcp" }` entries in
   * `tools` or `connections` — with the secrets and policy each grant sets
   * and the `provider` that builds them (spec 26 § MCP servers). Without it, a
   * node naming any server fails validation with `CONNECTION_NOT_ALLOWED`. The
   * planner is shown only the granted URLs.
   */
  mcp?: McpAllowlist;
}

//#endregion

//#region Constants

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_REVISIONS = 3;
const DEFAULT_MODEL = 'openai/gpt-4o';

const PLANNER_INSTRUCTIONS = `You are a workflow planner. Given a task, generate a JSON workflow document that describes how to accomplish it.

The workflow document must be valid JSON with this structure:
{
  "version": 1,
  "root": <WorkflowNode>
}

A WorkflowNode is one of:
- { "kind": "callModel", "id": "<unique>", "instructions": "<prompt>", "model": "<optional>", "tools": [<tool entry>, ...] } (one LLM call)
- { "kind": "invokeTool", "id": "<unique>", "toolName": "<name>", "args": { ... } } (call one tool directly, no LLM)
- { "kind": "runCode", "id": "<unique>", "execute": "<source code>" } (runs the code in a subprocess with the step input on stdin; only emit if the task needs deterministic computation AND a subprocess adapter is available)
- { "kind": "compute", "id": "<unique>", "expr": "<JSONata expression>" } (computes a value from the input, read as JSON, with no LLM; e.g. "{ 'n': n - 1, 'sum': sum + n }")
- { "kind": "sequence", "id": "<unique>", "steps": [<WorkflowNode>, ...] } (run children in order, threading each output into the next)
- { "kind": "inParallel", "id": "<unique>", "mode": "all"|"race"|"settle", "paths": [<WorkflowNode>, ...], "merge": "last"|"first"|"concat" } (fan out; supply exactly one of "paths" or "each": <WorkflowNode> — with "each", add "over": "<key>" to fan out over an array in the input JSON)
- { "kind": "loop", "id": "<unique>", "body": <WorkflowNode>, "until": <UntilPredicate>, "maxIterations": <optional positive int, or "infinity" for no cap> } (repeat the body until the predicate holds)
- { "kind": "conditional", "id": "<unique>", "routes": [{ "match": "<substring>", "target": <WorkflowNode> }], "default": <WorkflowNode> } (route on a substring of the input; a route may carry "expr": "<JSONata test, e.g. n > 3>" instead of "match", taken if the test gives true)
- { "kind": "spawn", "id": "<unique>", "child": <WorkflowNode>, "timeout": <optional ms> } (run the child in an isolated sub-context)
- { "kind": "withContext", "id": "<unique>", "child": <WorkflowNode>, "layers": ["<layer-name>", ...] } (run the child with named context layers; only emit if the task names layers that exist, since this planner provides no layer registry and unknown names resolve to NO layers)
- { "kind": "schedule", "id": "<unique>", "step": <WorkflowNode>, "interval": <ms>, "onError": "continue"|"fail" } (re-runs the step forever on an interval and never returns — only emit for an explicitly daemon-style task)
- { "kind": "routeSwitch", "id": "<unique>", "decide": { "kind": "decide", "id": "<unique>", "questions": { "<question-id>": { "type": "choice", "instructions": "<question>", "choices": ["<option>", ...] } } }, "on": "<question-id>", "cases": { "<option>": <WorkflowNode>, ... }, "uncertain": <WorkflowNode>, "minConfidence": <optional 0-1> } (a model decides, then the input goes to the matching case; a "boolean" question has cases "true" and "false"; a "score" question has "levels": ["<low>", ..., "<high>"] and routes by level; every outcome needs a case)
- { "kind": "subflow", "id": "<unique>", "document": { "version": 1, "root": <WorkflowNode> } } (an inline sub-workflow run as one step; only emit the inline form — named refs require a registry this planner does not provide)
- { "kind": "acp-agent", "id": "<unique>", "agent": "<an agent id listed below>", "prompt": "<turn prompt>", "mode": "<optional session mode>", "model": "<optional>", "tools": [<optional; connection and MCP server entries only>], "cwd": "<optional absolute dir>", "permissions": { "default": "deny", "allow": [{ "kind": "<tool kind>", "title": "<substring>" }] }, "clientCapabilities": { "readTextFile": <bool>, "writeTextFile": <bool>, "terminal": <bool> }, "session": { "reuse": "<key>", "keepAlive": "step"|"run" } } (every field after "model" is optional and only within the agent's limits listed below)

Every entry of a node's "tools" is an OBJECT, never a bare string. Use { "type": "<tool-name>" } to let the model call one of the tools listed below. Two provider-executed tools are also available without being listed: { "type": "openrouter:web_search" } and { "type": "openrouter:web_fetch" }, each accepting an optional "parameters" object. { "connection": "<name>", "ops": ["<operation glob>", ...] } gives the model the tools of a connection listed below ("ops" optional), and { "mcp": { "name": "<name>", "type": "http", "url": "<url>" } } those of an MCP server listed below. The same { "mcp": … } entry under the document's "connections" (keyed by its name) attaches the server for the whole document.

Any node may carry "emitItems": true to show its output to the user as an assistant message the moment it finishes, or "emitItems": { "onDone": "<JSONata expression on the output, e.g. 'Done ' & n & ' items'>" } to show computed text (no value shows nothing). Use it for progress inside loops: only the workflow's final output is shown otherwise. To stream a structured progress item, declare it in the document's root "customItems" map ({ "<name>": { "type": "<prefix>:<name>", "event": <JSON Schema>, "output": <JSON Schema of an object, without id or type> } }) and emit it with "emitItems": { "item": "<name>", "onStart": "<JSONata on the input: one event>", "onDone": "<JSONata on the output: the final fields>" }.

An acp-agent node delegates a turn to an external coding agent over the Agent Client Protocol; only emit one if a matching agent adapter is registered for the workflow.

An UntilPredicate (the "until" field of a loop) is one of:
{ "kind": "maxSteps", "n": <positive int> }, { "kind": "maxCost", "usd": <positive number> }, { "kind": "maxDuration", "duration": <ms> }, { "kind": "noToolCalls" }, { "kind": "never" } (never stops — pair with "maxIterations"), { "kind": "outputContains", "marker": "<text>" }, { "kind": "outputEquals", "sentinel": "<text>" }, { "kind": "converged", "threshold": <optional 0-1> }, { "kind": "expr", "expr": "<JSONata test on the last output, true stops, e.g. n = 0>" }, { "kind": "any", "predicates": [<UntilPredicate>, ...] }, { "kind": "all", "predicates": [<UntilPredicate>, ...] }.
A loop's "until" (or an entry of "any"/"all") may also be a decide node asking exactly one boolean question: { "kind": "decide", "id": "<unique>", "questions": { "<question-id>": { "type": "boolean", "instructions": "<question whose yes means stop>" } } } — a model reads the iteration's output; yes stops the loop, no or a refusal runs another iteration.

Respond with ONLY the JSON document, no markdown fences or explanation.`;

//#endregion

//#region Public API

/**
 * Creates a step that uses an LLM to generate a workflow as JSON, then
 * hydrates and executes it. The entire plan-and-execute cycle happens
 * within a single harness run.
 *
 * @public
 * @param opts.model - Model for the planner LLM. Default: `openai/gpt-4o`.
 * @param opts.instructions - Additional instructions prepended to the planner prompt.
 * @param opts.tools - Tools the generated workflow may reference by name.
 * @param opts.maxDepth - Maximum workflow tree depth. Default: 5.
 * @param opts.maxRevisions - Retries with error feedback on validation failure. Default: 3.
 * @param opts.expressionLimits - Bounds on each expression evaluation. Default: `DEFAULT_EXPRESSION_LIMITS`.
 * @returns A `Step` that dynamically plans and executes.
 * @throws `NoeticConfigError` with code `INVALID_EXPRESSION_LIMITS` (at execution) if `expressionLimits` holds a value that is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `EXPRESSION_LIMIT_EXCEEDED` (at execution) if an expression in the generated workflow exceeds its limits.
 * @throws `NoeticConfigError` with code `CONNECTION_NOT_ALLOWED` (at execution) if, on the last revision, the document asks for more than `connections`, `acp` or `mcp` grants.
 */
export function dynamicWorkflow(opts: DynamicWorkflowOpts): Step<ContextData, string, string> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxRevisions = opts.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const toolMap = buildToolMap(opts.tools);

  return runCode({
    id: 'dynamic-workflow',
    execute: async (input: string, ctx: Context): Promise<string> => {
      const harness = ctx.harness;
      if (!harness) {
        throw new NoeticConfigError({
          code: 'MISSING_HARNESS_CONTEXT',
          message: 'dynamicWorkflow requires a harness on the execution context.',
          hint: 'Execute this step via AgentHarness.run() or ensure ctx.harness is set.',
        });
      }

      checkAllowlistNames(opts.connections, ctx);
      // Read once: the planner is shown, the document checked against, and its
      // acp-agent nodes run in this cwd, even if the harness's moves meanwhile.
      const cwd = ctx.cwdState.cwd;
      const toolList = opts.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
      const basePrompt = [
        opts.instructions,
        PLANNER_INSTRUCTIONS,
        `\nAvailable tools:\n${toolList}`,
        connectionsPrompt(opts.connections, plannerConnections(opts.connections, ctx)),
        acpPrompt(opts.acpAgents, opts.acp, cwd),
        mcpPrompt(opts.mcp),
        `\nTask: ${input}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      let lastError: string | undefined;

      for (let revision = 0; revision < maxRevisions; revision++) {
        const prompt = lastError
          ? `${basePrompt}\n\nPrevious attempt failed with error: ${lastError}\nPlease fix the workflow and try again.`
          : basePrompt;

        // The planner only writes the document: it never sees the harness's tools or
        // connections, so it cannot drive a connection around the allowlist.
        const plannerStep = callModel({
          id: `dynamic-workflow-planner-${revision}`,
          model,
          instructions: prompt,
          tools: [],
        });

        const executeStep: ExecuteStepFn = frameworkCast(harness.run.bind(harness));
        const rawOutput = await executeStep(plannerStep, input, ctx);
        const text = coerceToString(rawOutput);

        const parseResult = tryParseWorkflow(text, maxDepth, {
          allowlist: opts.connections ?? {},
          ranges: profileVersions(ctx),
          acp: opts.acp,
          cwd,
          mcp: opts.mcp,
          secrets: harnessInternal<SecretResolver>(harness, 'secrets'),
        });
        if (!parseResult.ok) {
          lastError = parseResult.error;
          if (revision === maxRevisions - 1 && parseResult.configError) {
            throw parseResult.configError;
          }
          if (revision === maxRevisions - 1) {
            throw new NoeticConfigError({
              code: 'WORKFLOW_VALIDATION_FAILED',
              message: `Failed to generate valid workflow after ${maxRevisions} attempts: ${lastError}`,
              hint: 'The planner model may need clearer instructions or a more capable model.',
            });
          }
          continue;
        }

        const hydrationCtx: HydrationContext = {
          tools: toolMap,
          executeStep,
          acpAgents: opts.acpAgents,
          acpBounds: acpBounds(opts.acp, cwd),
          expressionLimits: opts.expressionLimits,
          allowlist: opts.connections ?? {},
          mcp: opts.mcp,
        };

        const hydrated = hydrateWorkflow(parseResult.doc, hydrationCtx);
        return frameworkCast(await executeStep(hydrated, input, ctx));
      }

      throw new NoeticConfigError({
        code: 'WORKFLOW_VALIDATION_FAILED',
        message: `Failed to generate valid workflow after ${maxRevisions} attempts.`,
        hint: 'The planner model may need clearer instructions or a more capable model.',
      });
    },
  });
}

/** @public Options for `parseAndRunWorkflow`. */
export interface ParseAndRunWorkflowOpts {
  json: unknown;
  harness: AgentHarnessContract;
  ctx: Context;
  tools: Tool[];
  input?: string;
  maxDepth?: number;
  /**
   * Context layers the document's `withContext` / `spawn` nodes may reference by name.
   * Without a registry those nodes resolve to NO layers rather than failing, so a
   * host that runs layer-bearing workflows must pass its layers here.
   */
  layers?: ReadonlyMap<string, ContextLayer>;
  /**
   * Named sub-workflows the document's `subflow` nodes may reference via `ref`.
   * A named workflow runs as the host wrote it, not held to `connections`,
   * `acp` or `mcp`: register only workflows you would let any document run
   * with their own settings.
   */
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  /**
   * Deepest allowed chain of named-ref resolutions on one execution path —
   * named workflows may recurse up to this depth. Positive integer or
   * `Infinity`. Default: 100.
   */
  maxRecursionDepth?: number;
  /** Bounds on each expression evaluation; unset fields use `DEFAULT_EXPRESSION_LIMITS`. */
  expressionLimits?: ExpressionLimits;
  /**
   * What the document may use of the harness's connections (spec 35 § What a
   * document may use). Absent grants none, like `{}`, as `acp` and `mcp` do:
   * a manifest entry, `{ "connection" }` pick or connection node asking for an
   * ungranted connection fails with `CONNECTION_NOT_ALLOWED`, and a
   * `callModel` or `acp-agent` node with no `tools` gets only the granted
   * connections. A host that trusts the document passes the grants it wants.
   */
  connections?: ConnectionAllowlist;
  /** ACP agent adapters, keyed by `agentId`, that the document's `acp-agent` nodes may run. Default: none. */
  acpAgents?: ReadonlyMap<string, AcpAgent>;
  /**
   * The most the document's `acp-agent` nodes may ask of each agent:
   * permissions, `cwd`, client capabilities and sessions (spec 26 § ACP
   * agents). An agent without an entry gets the narrowest defaults; a node
   * asking for more fails validation with `CONNECTION_NOT_ALLOWED`.
   */
  acp?: AcpAllowlist;
  /**
   * The MCP servers the document may attach — `{ "mcp" }` entries in `tools`
   * or `connections` — with the secrets and policy each grant sets and
   * the `provider` that builds them (spec 26 § MCP servers). Unlike
   * `connections`, absence grants nothing: a node naming any server fails
   * validation with `CONNECTION_NOT_ALLOWED`.
   */
  mcp?: McpAllowlist;
}

/**
 * Parses raw JSON into a `WorkflowDocument`, hydrates it into a live step
 * tree, and executes it via the harness.
 *
 * @public
 * @param opts.json - Raw JSON (string or parsed object) representing a workflow.
 * @param opts.harness - The agent harness to execute the workflow with.
 * @param opts.ctx - Execution context.
 * @param opts.tools - Available tools the workflow may reference.
 * @param opts.maxDepth - Maximum workflow tree depth. Default: 5.
 * @param opts.maxRecursionDepth - Deepest allowed chain of named-ref resolutions. Default: 100.
 * @param opts.expressionLimits - Bounds on each expression evaluation. Default: `DEFAULT_EXPRESSION_LIMITS`.
 * @returns The string output of the executed workflow.
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` if JSON is invalid.
 * @throws `NoeticConfigError` with code `WORKFLOW_RECURSION_LIMIT` if named refs nest deeper than `maxRecursionDepth`.
 * @throws `NoeticConfigError` with code `UNKNOWN_TOOL_REFERENCE` if a tool reference cannot be resolved.
 * @throws `NoeticConfigError` with code `INVALID_EXPRESSION_LIMITS` if `expressionLimits` holds a value that is not a positive integer or `Infinity`.
 * @throws `NoeticConfigError` with code `EXPRESSION_LIMIT_EXCEEDED` if an expression exceeds its limits.
 * @throws `NoeticConfigError` with code `CONNECTION_UNKNOWN` if a node uses a connection the document does not declare, or the allowlist names one the harness does not have.
 * @throws `NoeticConfigError` with code `CONNECTION_NOT_ALLOWED` if the document asks for more than `connections` grants (none when absent), an `acp-agent` node asks for more than `acp` grants, or the document names an MCP server `mcp` does not grant.
 * @throws `NoeticConfigError` with code `CONNECTION_INVALID` if an MCP server uses a `$secret` and the harness has no `environment.secrets`.
 */
export async function parseAndRunWorkflow(opts: ParseAndRunWorkflowOpts): Promise<string> {
  const allowlist = opts.connections ?? {};
  checkAllowlistNames(allowlist, opts.ctx);
  const cwd = opts.ctx.cwdState.cwd;
  const parseResult = tryParseWorkflow(opts.json, opts.maxDepth ?? DEFAULT_MAX_DEPTH, {
    allowlist,
    acp: opts.acp,
    cwd,
    mcp: opts.mcp,
    secrets: harnessInternal<SecretResolver>(opts.harness, 'secrets'),
  });
  if (!parseResult.ok && parseResult.configError) {
    throw parseResult.configError;
  }
  if (!parseResult.ok) {
    throw new NoeticConfigError({
      code: 'WORKFLOW_VALIDATION_FAILED',
      message: `Invalid workflow document: ${parseResult.error}`,
      hint: 'Ensure the JSON matches the WorkflowDocumentSchema.',
    });
  }

  const executeStep: ExecuteStepFn = frameworkCast(opts.harness.run.bind(opts.harness));
  const hydrationCtx: HydrationContext = {
    tools: buildToolMap(opts.tools),
    executeStep,
    layers: opts.layers,
    workflows: opts.workflows,
    acpAgents: opts.acpAgents,
    acpBounds: acpBounds(opts.acp, cwd),
    maxRecursionDepth: opts.maxRecursionDepth,
    expressionLimits: opts.expressionLimits,
    allowlist,
    mcp: opts.mcp,
  };

  const hydrated = hydrateWorkflow(parseResult.doc, hydrationCtx);
  const runSpan = beginWorkflowRunSpan(opts.harness, opts.ctx, parseResult.doc);
  try {
    const result = await executeStep(hydrated, opts.input ?? '', opts.ctx);
    return coerceToString(result);
  } finally {
    runSpan.end();
    await exportSpans(opts.harness.traceExporter, [
      runSpan,
    ]);
  }
}

/**
 * Open the root `workflow.run` span and stamp the static DAG onto it (document,
 * version, node/edge graph) plus the session/resource the run belongs to. The
 * span is installed on `ctx.span` so the LLM step's model/tool spans nest under
 * it — the trace tree then mirrors the declared workflow graph, with the
 * executed path overlaid (issue #50 follow-up). The session id (`ctx.threadId`)
 * is shared by every turn of a conversation, so consumers can group the per-run
 * traces of one session back together.
 */
function beginWorkflowRunSpan(
  harness: AgentHarnessContract,
  ctx: Context,
  doc: WorkflowDocument,
): Span {
  const span = harness.createSpan('workflow.run', null);
  const graph = workflowGraph(doc.root);
  span.setAttribute(NoeticAttr.WORKFLOW_DOCUMENT, JSON.stringify(doc));
  span.setAttribute(NoeticAttr.WORKFLOW_VERSION, doc.version);
  span.setAttribute(NoeticAttr.WORKFLOW_NODE_COUNT, graph.nodes.length);
  span.setAttribute(NoeticAttr.WORKFLOW_NODES, JSON.stringify(graph.nodes));
  span.setAttribute(NoeticAttr.WORKFLOW_EDGES, JSON.stringify(graph.edges));
  span.setAttribute(NoeticAttr.SESSION_ID, ctx.threadId);
  if (ctx.resourceId !== undefined) {
    span.setAttribute(NoeticAttr.RESOURCE_ID, ctx.resourceId);
  }
  installRunSpan(ctx, span);
  return span;
}

/** Install the run span as `ctx.span` so descendant model calls parent under it. */
function installRunSpan(ctx: Context, span: Span): void {
  frameworkCast<{
    span: Span;
  }>(ctx).span = span;
}

//#endregion

//#region Helpers

interface ParseOk {
  ok: true;
  doc: WorkflowDocument;
}

interface ParseFail {
  ok: false;
  error: string;
  /** A connection error (spec 35) that callers surface as is rather than as `WORKFLOW_VALIDATION_FAILED`. */
  configError?: NoeticConfigError;
}

/**
 * What the host lets a document use: `allowlist` the connections it grants,
 * and `acp` and `mcp`, undefined, their narrowest defaults.
 */
interface DocumentCheck {
  allowlist: ConnectionAllowlist;
  /**
   * Harness connection → profile → installed version. When given, a manifest
   * entry naming a profile without a range gets `^<major>` of the version the
   * connection serves (dynamicWorkflow fills the ranges in itself).
   */
  ranges?: ProfileVersions;
  /** The most `acp-agent` nodes may ask of each agent. */
  acp?: AcpAllowlist;
  /** The harness's working directory: an `acp-agent` node's `cwd` without an `acp` grant. */
  cwd: string;
  /** The MCP servers the document may name; undefined grants none. */
  mcp?: McpAllowlist;
  /** The harness's secret resolver, which a `$secret` in an MCP server needs. */
  secrets?: SecretResolver;
}

/** Harness connection → profile → the version it serves. */
type ProfileVersions = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** What the planner is shown of one allowed connection: the profiles it serves and its allowed operations. */
interface PlannerConnection {
  readonly profiles: Readonly<Record<string, string>>;
  readonly operations: ReadonlyArray<{
    readonly name: string;
    readonly inputSchema: unknown;
  }>;
}

/** The registry surface the planner reads. Structural: builders sit below the registry and must not import it. */
interface PlannerRegistry {
  names(): ReadonlyArray<string>;
  /** Harness names, then the names the turn rooted at `rootId` attached. */
  visibleNames(rootId?: string): ReadonlyArray<string>;
  current?(
    name: string,
    rootId?: string,
  ):
    | {
        readonly manifest: {
          readonly profiles: Readonly<Record<string, string>>;
          readonly operations: Readonly<
            Record<
              string,
              {
                readonly inputSchema: unknown;
              }
            >
          >;
        };
      }
    | undefined;
}

type ParseResult = ParseOk | ParseFail;

function buildToolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(
    tools.map((t) => [
      t.name,
      t,
    ]),
  );
}

/** A workflow's output as text, written the way every node writes its output (objects as JSON). */
function coerceToString(value: unknown): string {
  return outputText(value);
}

function tryParseWorkflow(raw: unknown, maxDepth: number, check: DocumentCheck): ParseResult {
  const json = typeof raw === 'string' ? safeParse(raw) : raw;
  if (json === null) {
    return {
      ok: false,
      error: 'Input is not valid JSON.',
    };
  }
  const parsed = check.ranges ? withProfileRanges(json, check.ranges) : json;

  const result = WorkflowDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const manifestError = manifestErrorOf(result.error.issues);
    return {
      ok: false,
      error: manifestError
        ? `${manifestError.code}: ${manifestError.message} ${manifestError.hint}`
        : result.error.message,
      ...(manifestError
        ? {
            configError: manifestError,
          }
        : {}),
    };
  }

  const depth = workflowDepth(result.data.root);
  if (depth > maxDepth) {
    return {
      ok: false,
      error: `Workflow tree depth ${depth} exceeds maximum ${maxDepth}.`,
    };
  }

  const errors = expressionErrors(result.data.root);
  if (errors.length > 0) {
    return {
      ok: false,
      error: errors.join(' '),
    };
  }

  const connectionError = connectionErrorOf(result.data, check);
  if (connectionError) {
    return {
      ok: false,
      error: `${connectionError.code}: ${connectionError.message} ${connectionError.hint}`,
      configError: connectionError,
    };
  }

  return {
    ok: true,
    doc: result.data,
  };
}

/** The error a document has, checked against its manifest, the host connection allowlist, and what its `acp-agent` nodes may ask. */
function connectionErrorOf(
  doc: WorkflowDocument,
  check: DocumentCheck,
): NoeticConfigError | undefined {
  try {
    checkConnectionAllowlist(doc, check.allowlist);
    checkToolConnections(doc, check.allowlist);
    checkAcpAgents(doc, check.acp, check.cwd);
    checkMcpServers(doc, check.mcp, check.secrets);
    return undefined;
  } catch (error) {
    if (isNoeticConfigError(error)) {
      return error;
    }
    throw error;
  }
}

/**
 * Checks an allowlist names only connections the harness or the turn has, when
 * the harness has a connection registry to ask.
 *
 * @throws `NoeticConfigError` `CONNECTION_UNKNOWN` for a name neither has.
 */
function checkAllowlistNames(allowlist: ConnectionAllowlist | undefined, ctx: Context): void {
  const registry = registryOf(ctx);
  if (!allowlist || !registry) {
    return;
  }
  const known = new Set(registry.visibleNames(rootOf(ctx).id));
  for (const name of Object.keys(allowlist)) {
    if (known.has(name)) {
      continue;
    }
    throw new NoeticConfigError({
      code: 'CONNECTION_UNKNOWN',
      message: `The connection allowlist names '${name}', which neither the harness nor the turn has.`,
      hint: `Connections: ${
        [
          ...known,
        ].join(', ') || '(none)'
      }.`,
    });
  }
}

/**
 * A malformed manifest entry (spec 35 § Errors) is `CONNECTION_INVALID`, not a
 * generic validation failure: the issues under the root `connections` map.
 */
function manifestErrorOf(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): NoeticConfigError | undefined {
  const manifest = issues.filter((issue) => issue.path[0] === 'connections');
  if (manifest.length === 0) {
    return undefined;
  }
  const detail = manifest
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `The document's connections map is malformed: ${detail}`,
    hint: 'Each entry is { "profile": "<profile>@<range>", "extensions"?, "from"?, "fresh"?, "setup"? } or { "events": [...] }.',
  });
}

/** Structural: builders sit below the connection registry and must not import it. */
function registryOf(ctx: Context): PlannerRegistry | undefined {
  return harnessInternal<PlannerRegistry>(ctx.harness, 'connectionRegistry');
}

/** The profile versions each harness connection serves right now. */
function profileVersions(ctx: Context): ProfileVersions {
  const registry = registryOf(ctx);
  const versions = new Map<string, Readonly<Record<string, string>>>();
  for (const name of registry?.names() ?? []) {
    const profiles = registry?.current?.(name)?.manifest.profiles;
    if (profiles) {
      versions.set(name, profiles);
    }
  }
  return versions;
}

/** `^<major>` of `version`, or undefined when it is not a version. */
function caretRange(version: string | undefined): string | undefined {
  const major = version?.split('.')[0];
  return major && /^\d+$/.test(major) ? `^${major}` : undefined;
}

/** `json` with each manifest entry's bare `"profile": "<name>"` given the range its connection serves. */
function withProfileRanges(json: unknown, ranges: ProfileVersions): unknown {
  if (!isRecord(json) || !isRecord(json.connections)) {
    return json;
  }
  const connections: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(json.connections)) {
    connections[name] = withProfileRange(name, entry, ranges);
  }
  return {
    ...json,
    connections,
  };
}

function withProfileRange(name: string, entry: unknown, ranges: ProfileVersions): unknown {
  if (!isRecord(entry) || typeof entry.profile !== 'string' || entry.profile.includes('@')) {
    return entry;
  }
  const target = typeof entry.from === 'string' ? entry.from : name;
  const range = caretRange(ranges.get(target)?.[entry.profile]);
  return range
    ? {
        ...entry,
        profile: `${entry.profile}@${range}`,
      }
    : entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the planner may see of each allowed connection: its profiles and allowed operations with their schemas. */
function plannerConnections(
  allowlist: ConnectionAllowlist | undefined,
  ctx: Context,
): ReadonlyMap<string, PlannerConnection> {
  const registry = registryOf(ctx);
  const out = new Map<string, PlannerConnection>();
  for (const [name, entry] of Object.entries(allowlist ?? {})) {
    const manifest = registry?.current?.(name, rootOf(ctx).id)?.manifest;
    if (!manifest) {
      continue;
    }
    const operations = Object.entries(manifest.operations)
      .filter(([op]) => (entry.ops ?? []).some((pattern) => globMatches(pattern, op)))
      .map(([op, info]) => ({
        name: op,
        inputSchema: info.inputSchema,
      }));
    out.set(name, {
      profiles: manifest.profiles,
      operations,
    });
  }
  return out;
}

function connectionLine(
  name: string,
  entry: ConnectionAllowlist[string],
  known: PlannerConnection | undefined,
): string {
  const profiles = Object.keys(known?.profiles ?? {});
  const parts = [
    ...(profiles.length > 0
      ? [
          `profiles: ${profiles.join(', ')}`,
        ]
      : []),
    `ops: ${(entry.ops ?? []).join(', ') || '(none)'}`,
    `events: ${(entry.events ?? []).join(', ') || '(none)'}`,
  ];
  if (entry.setup) {
    parts.push(`setup fields: ${Object.keys(entry.setup).join(', ')}`);
  }
  if (entry.secrets) {
    parts.push(
      `secrets: ${Object.entries(entry.secrets)
        .map(([secret, field]) => `${secret} (only in ${field})`)
        .join(', ')}`,
    );
  }
  const schemas = (known?.operations ?? []).map(
    (op) => `    - ${op.name} args: ${JSON.stringify(op.inputSchema)}`,
  );
  return [
    `- ${name}: ${parts.join('; ')}`,
    ...schemas,
  ].join('\n');
}

/** The planner's view of the connections it may use: only the allowed ones, with their operations and argument schemas. */
function connectionsPrompt(
  allowlist: ConnectionAllowlist | undefined,
  known: ReadonlyMap<string, PlannerConnection>,
): string {
  const entries = Object.entries(allowlist ?? {});
  if (entries.length === 0) {
    return '\nNo connections are available: do not emit call, wait or verify nodes or a "connections" map.';
  }
  const lines = entries.map(([name, entry]) => connectionLine(name, entry, known.get(name)));
  return `\nConnections you may use (a document lists the ones it needs in a root "connections" map, e.g. "connections": { "app": { "profile": "<profile>", "from": "<connection>" } } — the version range is filled in for you — or { "events": [...] } for an event source):
${lines.join('\n')}
Connection nodes:
- { "kind": "call", "id": "<unique>", "connection": "<name>", "op": "<operation>", "args": { ... } } (run one operation; values may be { "$expr": "<JSONata on the input; $steps.<id> reads an earlier node's output>" }, { "$literal": ... }, or { "$secret": "<name>" })
- { "kind": "wait", "id": "<unique>", "connection": "<name>", "event": "<event>", "filter": "<JSONata test on { event, input }>", "around": [<steps>], "timeoutMs": <ms> } (listen, run around, then wait for the event)
- { "kind": "verify", "id": "<unique>", "subject": "<name>", "expect": [{ "<sense>": "<pattern>" }, ...], "never": [<matchers>], "act": [<steps>], "witnesses": ["<name>"], "close": { "until": "quiet"|"event"|"done"|"exit" } } (run act on the subject and check what was expected happened; act names operations by name)
Inside "around", "act" or a sequence's "steps", { "<operation>": { ...args } } is a call on the enclosing connection.
A callModel or acp-agent node may instead give the model a connection's tools with the "tools" entry { "connection": "<name>", "ops": [<optional; globs within the ops above>] }; this needs no "connections" map.`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

//#endregion
