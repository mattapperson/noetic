/**
 * Pattern that lets an LLM generate a workflow as JSON during execution,
 * then hydrates and runs it within the same harness session.
 */

import type { ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  Context,
  ExecuteStepFn,
  Span,
  Step,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { expressionErrors } from '../expression/check';
import type { ExpressionLimits } from '../expression/jsonata';
import { NoeticAttr } from '../observability/genai-attributes';
import type { WorkflowDocument } from '../schemas/workflow';
import { WorkflowDocumentSchema, workflowDepth, workflowGraph } from '../schemas/workflow';
import { callModel, runCode } from './step-builders';
import type { HydrationContext } from './workflow-hydrator';
import { hydrateWorkflow } from './workflow-hydrator';

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
- { "kind": "callModel", "id": "<unique>", "instructions": "<prompt>", "model": "<optional>", "tools": [{ "type": "<tool-name>" }, ...] } (one LLM call)
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
- { "kind": "acp-agent", "id": "<unique>", "agent": "<registered agent id, e.g. claude-code>", "prompt": "<turn prompt>", "mode": "<optional session mode>", "model": "<optional>" }

Every entry of a callModel node's "tools" is an OBJECT, never a bare string. Use { "type": "<tool-name>" } to let the model call one of the tools listed below. Two provider-executed tools are also available without being listed: { "type": "openrouter:web_search" } and { "type": "openrouter:web_fetch" }, each accepting an optional "parameters" object.

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

      const toolList = opts.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
      const basePrompt = [
        opts.instructions,
        PLANNER_INSTRUCTIONS,
        `\nAvailable tools:\n${toolList}`,
        `\nTask: ${input}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      let lastError: string | undefined;

      for (let revision = 0; revision < maxRevisions; revision++) {
        const prompt = lastError
          ? `${basePrompt}\n\nPrevious attempt failed with error: ${lastError}\nPlease fix the workflow and try again.`
          : basePrompt;

        const plannerStep = callModel({
          id: `dynamic-workflow-planner-${revision}`,
          model,
          instructions: prompt,
        });

        const executeStep: ExecuteStepFn = frameworkCast(harness.run.bind(harness));
        const rawOutput = await executeStep(plannerStep, input, ctx);
        const text = coerceToString(rawOutput);

        const parseResult = tryParseWorkflow(text, maxDepth);
        if (!parseResult.ok) {
          lastError = parseResult.error;
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
          expressionLimits: opts.expressionLimits,
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
  /** Named sub-workflows the document's `subflow` nodes may reference via `ref`. */
  workflows?: ReadonlyMap<string, WorkflowDocument>;
  /**
   * Deepest allowed chain of named-ref resolutions on one execution path —
   * named workflows may recurse up to this depth. Positive integer or
   * `Infinity`. Default: 100.
   */
  maxRecursionDepth?: number;
  /** Bounds on each expression evaluation; unset fields use `DEFAULT_EXPRESSION_LIMITS`. */
  expressionLimits?: ExpressionLimits;
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
 */
export async function parseAndRunWorkflow(opts: ParseAndRunWorkflowOpts): Promise<string> {
  const parseResult = tryParseWorkflow(opts.json, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
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
    maxRecursionDepth: opts.maxRecursionDepth,
    expressionLimits: opts.expressionLimits,
  };

  const hydrated = hydrateWorkflow(parseResult.doc, hydrationCtx);
  const runSpan = beginWorkflowRunSpan(opts.harness, opts.ctx, parseResult.doc);
  try {
    const result = await executeStep(hydrated, opts.input ?? '', opts.ctx);
    return coerceToString(result);
  } finally {
    runSpan.end();
    await opts.harness.traceExporter.export([
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

function coerceToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return String(value ?? '');
}

function tryParseWorkflow(raw: unknown, maxDepth: number): ParseResult {
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (parsed === null) {
    return {
      ok: false,
      error: 'Input is not valid JSON.',
    };
  }

  const result = WorkflowDocumentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.message,
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

  return {
    ok: true,
    doc: result.data,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

//#endregion
