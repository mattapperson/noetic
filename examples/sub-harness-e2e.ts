/**
 * Manual end-to-end check for sub-harness steps.
 *
 * Exercises the REAL runtime — AgentHarness.run() and the JSON
 * hydrate-and-run path — with the real `claudeCode()` / `codex()` adapters.
 * The only stub is the turn `runner` (the vendor-SDK seam), so everything from
 * the builder through the interpreter, item log, usage tracking, structured
 * output, and JSON hydration runs for real.
 *
 * Run: bun examples/sub-harness-e2e.ts
 */

import type { ExecuteStepFn } from '@noetic-tools/core';
import {
  AgentHarness,
  createMessage,
  hydrateWorkflow,
  step,
  validateWorkflow,
} from '@noetic-tools/core';
import type { SubHarnessRunner } from '@noetic-tools/sub-harness';
import { createSubHarnessRegistry } from '@noetic-tools/sub-harness';
import { claudeCode } from '@noetic-tools/sub-harness-claude-code';
import { codex } from '@noetic-tools/sub-harness-codex';
import { z } from 'zod';

// An echo runner standing in for a vendor SDK: emits text, a tool call, then finish.
function echoRunner(text: string): SubHarnessRunner {
  return async function* () {
    yield {
      type: 'text-delta',
      delta: text,
    };
    yield {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'Bash',
      input: {
        cmd: 'ls',
      },
    };
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: {
        input: 12,
        output: 8,
      },
      cost: 0.0003,
    };
  };
}

function ok(label: string, cond: boolean): void {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const harness = new AgentHarness({
    name: 'sub-harness-e2e',
    params: {},
  });

  // ── Path A: programmatic, via AgentHarness.run() ──────────────────────────
  console.log('\n── Path A: programmatic (step.claudeCode + harness.run) ──');
  const codeStep = step.claudeCode({
    id: 'code-path',
    harness: claudeCode({
      runner: echoRunner('summary: 3 packages, all green'),
      model: 'claude-opus-4-8',
    }),
    prompt: 'Summarize the repository',
  });
  const ctxA = harness.createContext();
  const outA = await harness.run(codeStep, undefined, ctxA);
  console.log('  output:', JSON.stringify(outA));
  console.log(
    '  itemLog items:',
    ctxA.itemLog.items.length,
    '| tokens.total:',
    ctxA.tokens.total,
    '| cost:',
    ctxA.cost,
  );
  ok('returns the assistant text', outA === 'summary: 3 packages, all green');
  ok('appended user + assistant + tool-call items', ctxA.itemLog.items.length === 3);
  ok('tracked usage (total 20)', ctxA.tokens.total === 20);
  ok('tracked cost', ctxA.cost === 0.0003);
  ok('recorded lastStepMeta tool calls', (ctxA.lastStepMeta?.toolCalls?.length ?? 0) === 1);

  // ── Path B: JSON API, validate → hydrate(registry) → run ──────────────────
  console.log('\n── Path B: JSON API (validateWorkflow + hydrateWorkflow + harness.run) ──');
  const doc = {
    version: 1,
    root: {
      kind: 'claude-code',
      id: 'json-path',
      prompt: 'List the open TODOs',
      settings: {
        model: 'claude-opus-4-8',
        permissionMode: 'plan',
      },
    },
  };
  const validated = validateWorkflow(doc);
  ok('document validates against the workflow schema', validated.root.kind === 'claude-code');

  const registry = createSubHarnessRegistry(
    claudeCode({
      runner: echoRunner('TODO: ship it'),
    }),
  );
  const executeStep: ExecuteStepFn = (s, i, c) => harness.run(s, i, c);
  const hydrated = hydrateWorkflow(validated, {
    tools: new Map(),
    executeStep,
    subHarnesses: registry,
  });
  ok('node hydrates into a claude-code step', hydrated.kind === 'claude-code');

  const ctxB = harness.createContext();
  const outB = await harness.run(hydrated, '', ctxB);
  console.log('  output:', JSON.stringify(outB));
  ok('JSON workflow runs and returns the agent output', outB === 'TODO: ship it');

  // ── Path C: structured output through the step schema ─────────────────────
  console.log('\n── Path C: structured output (step.codex + output schema) ──');
  const Schema = z.object({
    files: z.number(),
    clean: z.boolean(),
  });
  const structuredStep = step.codex({
    id: 'structured',
    harness: codex({
      runner: echoRunner('{"files":3,"clean":true}'),
    }),
    prompt: 'Inspect the workspace',
    output: Schema,
  });
  const ctxC = harness.createContext();
  const outC = await harness.run(structuredStep, undefined, ctxC);
  console.log('  output:', JSON.stringify(outC));
  ok('parses structured output via the step schema', outC.files === 3 && outC.clean === true);

  // ── Path D: agent output mapped onto the harness event surface ────────────
  console.log('\n── Path D: streaming via getFullStream() (session path) ──');
  const streamHarness = new AgentHarness({
    name: 'stream-demo',
    params: {},
    initialStep: step.claudeCode({
      id: 'stream',
      harness: claudeCode({
        runner: echoRunner('streamed agent output'),
      }),
      prompt: 'go',
    }),
  });
  await streamHarness.execute('go');
  let streamed = '';
  let sawCompleted = false;
  for await (const ev of streamHarness.getFullStream()) {
    if (
      ev.source === 'sdk' &&
      ev.type === 'response.output_text.delta' &&
      typeof ev.data.delta === 'string'
    ) {
      streamed += ev.data.delta;
    }
    if (ev.source === 'sdk' && ev.type === 'response.completed') {
      sawCompleted = true;
      break;
    }
  }
  console.log(
    '  getFullStream() text:',
    JSON.stringify(streamed),
    '| response.completed:',
    sawCompleted,
  );
  ok(
    'agent output streams through the harness event surface',
    streamed === 'streamed agent output' && sawCompleted,
  );

  // ── Path E: the sub-harness receives prior conversation (full context) ────
  console.log('\n── Path E: conversational history passed to the sub-harness ──');
  const ctxE = harness.createContext();
  // Earlier conversation (as if from prior LLM steps).
  ctxE.itemLog.append(createMessage('Remember: we deploy to prod only on Fridays.', 'user'));
  ctxE.itemLog.append(createMessage('Understood.', 'developer'));
  // A runner that answers strictly from the history it was given.
  const contextRunner: SubHarnessRunner = async function* (input) {
    const knows = input.history.some(
      (i) =>
        i.type === 'message' && i.content.some((c) => 'text' in c && c.text.includes('Fridays')),
    );
    const text = knows
      ? 'We deploy to prod on Fridays.'
      : 'I have no record of our deploy schedule.';
    yield {
      type: 'text-delta',
      delta: text,
    };
    yield {
      type: 'finish',
      finishReason: 'stop',
    };
  };
  const ctxStep = step.claudeCode({
    id: 'ctx',
    harness: claudeCode({
      runner: contextRunner,
    }),
    prompt: 'When do we deploy to prod?',
  });
  const outE = await harness.run(ctxStep, undefined, ctxE);
  console.log('  output:', JSON.stringify(outE));
  ok(
    'sub-harness answers from prior conversation (full context, no confusion)',
    outE.includes('Fridays'),
  );

  console.log(process.exitCode ? '\n❌ FAILED' : '\n✅ ALL PATHS PASSED');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
