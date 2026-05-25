/**
 * Pattern that lets an LLM generate a workflow as JSON during execution,
 * then hydrates and runs it within the same harness session.
 */

import { step } from '../builders/step-builders';
import type { HydrationContext } from '../builders/workflow-hydrator';
import { hydrateWorkflow } from '../builders/workflow-hydrator';
import { NoeticConfigError } from '../errors/noetic-config-error';
import type { WorkflowDocument } from '../schemas/workflow';
import { WorkflowDocumentSchema, workflowDepth } from '../schemas/workflow';
import type { Context } from '../types/context';
import type { ContextMemory } from '../types/memory';
import type { AgentHarnessContract } from '../types/runtime';
import type { ExecuteStepFn, Step } from '../types/step';
import type { Tool } from '../types/tool';
import { frameworkCast } from '../util/framework-cast';

//#region Types

/** @public Options for creating a dynamic workflow step. */
export interface DynamicWorkflowOpts {
  model?: string;
  instructions?: string;
  tools: Tool[];
  maxDepth?: number;
  maxRevisions?: number;
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
- { "kind": "llm", "id": "<unique>", "instructions": "<prompt>", "model": "<optional>", "tools": ["<tool-name>", ...] }
- { "kind": "tool", "id": "<unique>", "toolName": "<name>", "args": { ... } }
- { "kind": "sequence", "id": "<unique>", "steps": [<WorkflowNode>, ...] }
- { "kind": "fork", "id": "<unique>", "mode": "all"|"race"|"settle", "paths": [<WorkflowNode>, ...], "merge": "last"|"first"|"concat" }
- { "kind": "loop", "id": "<unique>", "body": <WorkflowNode>, "until": { "kind": "maxSteps", "n": <number> } }
- { "kind": "branch", "id": "<unique>", "routes": [{ "match": "<substring>", "target": <WorkflowNode> }], "default": <WorkflowNode> }
- { "kind": "spawn", "id": "<unique>", "child": <WorkflowNode> }

Until predicates: maxSteps, maxCost, maxDuration, noToolCalls, outputContains, outputEquals, converged, any, all.

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
 * @returns A `Step` that dynamically plans and executes.
 */
export function dynamicWorkflow(opts: DynamicWorkflowOpts): Step<ContextMemory, string, string> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxRevisions = opts.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const toolMap = buildToolMap(opts.tools);

  return step.run({
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

        const plannerStep = step.llm({
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
 * @returns The string output of the executed workflow.
 * @throws `NoeticConfigError` with code `WORKFLOW_VALIDATION_FAILED` if JSON is invalid.
 * @throws `NoeticConfigError` with code `UNKNOWN_TOOL_REFERENCE` if a tool reference cannot be resolved.
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
  };

  const hydrated = hydrateWorkflow(parseResult.doc, hydrationCtx);
  const result = await executeStep(hydrated, opts.input ?? '', opts.ctx);
  return coerceToString(result);
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
