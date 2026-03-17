/**
 * Async Sub-Agent Delegation Demo
 *
 * Shows an LLM agent launching sub-agents without blocking, continuing work,
 * and receiving results via an inbox channel when sub-agents complete.
 */
import { z } from 'zod';
import { channel } from '../src/builders/channel-builder';
import { loop } from '../src/builders/loop-builder';
import { step } from '../src/builders/step-builders';
import type { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { Channel } from '../src/types/channel';
import type { DetachedHandle } from '../src/types/detached';
import type { StepLoop } from '../src/types/step';
import { any } from '../src/until/combinators';
import { until } from '../src/until/predicates';
import { createExampleRuntime } from './create-example-runtime';
import { createAsyncLaunchTool, createCheckTool } from './delegate-tools';

//#region Inbox Channel

export const agentInbox = channel('agent-inbox', {
  schema: z.string(),
  mode: 'queue',
});

//#endregion

//#region Demo Step Builder

/** Builds an agent loop with async delegation via inbox channel. */
export function buildAsyncDelegateAgent(opts: {
  runtime: InMemoryRuntime;
  inbox: Channel<string>;
  parkTimeout?: number;
}): StepLoop<string, string> {
  const handles = new Map<string, DetachedHandle<string>>();

  const launchTool = createAsyncLaunchTool({
    runtime: opts.runtime,
    inbox: opts.inbox,
    handles,
  });
  const checkTool = createCheckTool(handles);

  return loop({
    id: 'async-delegate-loop',
    body: step.llm({
      id: 'async-delegate-llm',
      model: 'gpt-4o',
      system: 'You are an assistant that can launch background sub-agents.',
      tools: [
        launchTool,
        checkTool,
      ],
    }),
    until: any(until.noToolCalls(), until.maxSteps(10)),
    inbox: opts.inbox,
    parkTimeout: opts.parkTimeout ?? 5e3,
  });
}

//#endregion

//#region Main

async function main(): Promise<void> {
  const runtime = createExampleRuntime();

  const agent = buildAsyncDelegateAgent({
    runtime,
    inbox: agentInbox,
  });
  const ctx = runtime.createContext();
  const result = await runtime.execute(agent, 'Research quantum computing for me', ctx);

  console.log(result);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

//#endregion
