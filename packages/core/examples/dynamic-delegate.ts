/**
 * Dynamic Delegation Demo
 *
 * Shows an LLM agent with BOTH sync and async delegation tools.
 * The LLM dynamically chooses which to use via tool calling:
 * - `delegate`: blocks until sub-agent finishes (sync)
 * - `launch_agent`: runs sub-agent in background (async)
 */
import { z } from 'zod';
import { channel } from '../src/builders/channel-builder';
import { step } from '../src/builders/step-builders';
import type { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { Channel } from '../src/types/channel';
import type { DetachedHandle } from '../src/types/detached';
import type { StepLoop } from '../src/types/step';
import { any } from '../src/until/combinators';
import { until } from '../src/until/predicates';
import { createExampleRuntime } from './create-example-runtime';
import { createAsyncLaunchTool, createSyncDelegateTool } from './delegate-tools';

//#region Inbox Channel

export const delegateInbox = channel('delegate-inbox', {
  schema: z.string(),
  mode: 'queue',
});

//#endregion

//#region Demo Step Builder

/** Builds an agent loop where the LLM can choose sync or async delegation. */
export function buildDynamicDelegateAgent(opts: {
  runtime: InMemoryRuntime;
  inbox: Channel<string>;
  parkTimeout?: number;
}): StepLoop<string, string> {
  const handles = new Map<string, DetachedHandle<string>>();

  const syncTool = createSyncDelegateTool(opts.runtime);
  const asyncTool = createAsyncLaunchTool({
    runtime: opts.runtime,
    inbox: opts.inbox,
    handles,
  });

  return {
    kind: 'loop',
    id: 'dynamic-delegate-loop',
    body: step.llm({
      id: 'dynamic-delegate-llm',
      model: 'gpt-4o',
      system: `You are an orchestrator with two delegation strategies:
- delegate: blocks and returns the result. Use for tasks you need answered before continuing.
- launch_agent: runs in background. Use when you can keep working while it runs.
Choose the right strategy based on each task.`,
      tools: [
        syncTool,
        asyncTool,
      ],
    }),
    until: any(until.noToolCalls(), until.maxSteps(10)),
    inbox: opts.inbox,
    parkTimeout: opts.parkTimeout ?? 5e3,
  };
}

//#endregion

//#region Main

async function main(): Promise<void> {
  const runtime = createExampleRuntime();

  const agent = buildDynamicDelegateAgent({
    runtime,
    inbox: delegateInbox,
  });
  const ctx = runtime.createContext();
  const result = await runtime.execute(agent, 'Research AI safety and answer: what is 2+2?', ctx);

  console.log(result);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

//#endregion
