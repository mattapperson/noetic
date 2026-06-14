/**
 * End-to-end example: an Opus planner *generates* a JSON workflow, that
 * workflow is validated against the published schema, and then it is executed.
 *
 * The generated workflow fans a single question out to four different models
 * in parallel, then pipes their answers to an Opus judge that synthesises one
 * ideal response — the classic "mixture-of-agents" / LLM-as-judge pattern,
 * expressed entirely as data (a `WorkflowDocument`) rather than code.
 *
 * Run it (requires `OPENROUTER_API_KEY`):
 *
 *   OPENROUTER_API_KEY=sk-... bun examples/dynamic-judge-workflow.ts
 *   OPENROUTER_API_KEY=sk-... bun examples/dynamic-judge-workflow.ts "Your question here"
 *
 * A canonical, hand-checked version of the workflow this planner produces is
 * committed alongside it at `examples/multi-model-judge.workflow.json`.
 */

import type { WorkflowDocument } from '@noetic-tools/core';
import {
  AgentHarness,
  parseAndRunWorkflow,
  step,
  validateWorkflow,
  workflowDepth,
} from '@noetic-tools/core';

//#region Configuration

const DEFAULT_QUESTION =
  'What were the primary causes of the fall of the Western Roman Empire, and which was most decisive?';

/** The planner that writes the workflow. Opus is asked to design the panel. */
const PLANNER_MODEL = 'anthropic/claude-opus-4.5';

/** The four panel models the generated workflow should consult in parallel. */
const PANEL_MODELS = [
  'openai/gpt-4.1',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat',
] as const;

/** The judge that synthesises the four answers into the final response. */
const JUDGE_MODEL = 'anthropic/claude-opus-4.5';

const MAX_REVISIONS = 3;
const MAX_DEPTH = 5;

//#endregion

//#region Planner

function buildPlannerInstructions(): string {
  return [
    'You are a workflow planner for the Noetic JSON workflow runtime.',
    'Emit a single WorkflowDocument as JSON with this exact shape:',
    '{ "version": 1, "root": <WorkflowNode> }',
    '',
    'The only node kinds you need here, with their EXACT fields:',
    '- llm:      { "kind": "llm", "id": "<unique>", "model": "<model-id>", "instructions": "<system prompt>" }',
    '- fork:     { "kind": "fork", "id": "<unique>", "mode": "settle", "merge": "concat", "paths": [<llm>, ...] }',
    '- sequence: { "kind": "sequence", "id": "<unique>", "steps": [<node>, ...] }',
    'The prompt field is named "instructions" (a string) — never "prompt".',
    '',
    'Design a "mixture-of-agents" workflow for the user question:',
    '1. The root is a "sequence" with two steps.',
    '2. The sequence\'s first step is a "fork" (mode "settle" so a flaky model',
    '   cannot abort the panel, merge "concat") with exactly four "llm" paths,',
    '   one per model, in this order:',
    PANEL_MODELS.map((m, i) => `   - path ${i + 1}: model "${m}"`).join('\n'),
    '   Each panel llm answers the question and prefixes its reply with a',
    "   '## Candidate (<model>)' header line so the judge can tell them apart.",
    `3. The sequence's second step is an "llm" judge with model "${JUDGE_MODEL}"`,
    '   that receives the concatenated candidate answers and synthesises one',
    '   ideal response, outputting only the final answer.',
    '',
    'Every node needs a unique non-empty "id". Respond with ONLY the JSON',
    'document — no markdown fences, no commentary.',
  ].join('\n');
}

/** Extracts the JSON object from a model reply (drops fences / surrounding prose). */
function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return text.trim();
  }
  return text.slice(start, end + 1);
}

/** Runs the Opus planner, retrying with error feedback until it emits a valid document. */
async function generateWorkflow(
  harness: AgentHarness,
  question: string,
): Promise<WorkflowDocument> {
  const base = `${buildPlannerInstructions()}\n\nUser question: ${question}`;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_REVISIONS; attempt++) {
    const instructions = lastError
      ? `${base}\n\nYour previous attempt was invalid: ${lastError}\nFix it and try again.`
      : base;

    const planner = step.llm({
      id: `planner-${attempt}`,
      model: PLANNER_MODEL,
      instructions,
    });

    const ctx = harness.createContext();
    const raw = extractJson(await harness.run(planner, question, ctx));

    try {
      const doc = validateWorkflow(JSON.parse(raw));
      const depth = workflowDepth(doc.root);
      if (depth > MAX_DEPTH) {
        throw new Error(`workflow depth ${depth} exceeds maximum ${MAX_DEPTH}`);
      }
      return doc;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`  attempt ${attempt} failed: ${lastError}`);
    }
  }

  throw new Error(`Planner failed to produce a valid workflow after ${MAX_REVISIONS} attempts.`);
}

//#endregion

//#region Entry

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Set OPENROUTER_API_KEY to run this example.');
  }

  const question = process.argv[2] ?? DEFAULT_QUESTION;

  const harness = new AgentHarness({
    name: 'dynamic-judge-workflow',
    params: {},
    llm: {
      provider: 'openrouter',
      apiKey,
    },
  });

  console.log(`Question: ${question}\n`);

  console.log('1. Opus is generating a workflow...');
  const doc = await generateWorkflow(harness, question);
  console.log('   ✓ valid WorkflowDocument generated\n');
  console.log('--- generated workflow ---');
  console.log(JSON.stringify(doc, null, 2));
  console.log('--------------------------\n');

  console.log('2. Executing the generated workflow (4 models → judge)...');
  const ctx = harness.createContext();
  const answer = await parseAndRunWorkflow({
    json: doc,
    harness,
    ctx,
    tools: [],
    input: question,
    maxDepth: MAX_DEPTH,
  });

  console.log('\n=== synthesised answer ===\n');
  console.log(answer);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

//#endregion
