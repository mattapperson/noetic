/**
 * Async Sub-Agent Delegation Demo
 *
 * Shows an LLM agent launching sub-agents without blocking, continuing work,
 * and receiving results via an inbox channel when sub-agents complete.
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
}): StepLoop<string, string> {
  const handles = new Map<string, DetachedHandle<string>>();

  const launchTool = createAsyncLaunchTool({
    runtime: opts.runtime,
    inbox: opts.inbox,
    handles,
  });
  const checkTool = createCheckTool(handles);

  return {
    kind: 'loop',
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
    parkTimeout: 5e3,
  };
}

//#endregion
