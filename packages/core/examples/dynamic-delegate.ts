/**
 * Dynamic Delegation Demo
 *
 * Shows an LLM agent with BOTH sync and async delegation tools.
 * The LLM dynamically chooses which to use via tool calling:
 * - `delegate`: blocks until sub-agent finishes (sync)
 * - `launch_agent`: runs sub-agent in background (async)
 *
 * Flow: User input → LLM loop → LLM picks sync or async tool → sub-agent(s) run
 *       → results collected → LLM synthesizes final answer
 */
import { z } from 'zod';
import { channel } from '../src/builders/channel-builder';
import { loop } from '../src/builders/loop-builder';
import { step } from '../src/builders/step-builders';
import type { Channel } from '../src/types/channel';
import type { DetachedHandle } from '../src/types/detached';
import type { ContextMemory } from '../src/types/memory';
import type { StepLoop } from '../src/types/step';
import { any } from '../src/until/combinators';
import { until } from '../src/until/predicates';
import { createAsyncLaunchTool, createSyncDelegateTool } from './delegate-tools';

//#region Inbox Channel

export const delegateInbox = channel('delegate-inbox', {
  schema: z.string(),
  mode: 'queue',
});

//#endregion

//#region Agent Builder

/** Builds an agent loop where the LLM can choose sync or async delegation. */
export function buildDynamicDelegateAgent(opts: {
  inbox: Channel<string>;
  parkTimeout?: number;
}): StepLoop<ContextMemory, string, string> {
  const handles = new Map<string, DetachedHandle<string>>();

  const syncTool = createSyncDelegateTool();
  const asyncTool = createAsyncLaunchTool({
    inbox: opts.inbox,
    handles,
  });

  return loop({
    id: 'dynamic-delegate-loop',
    steps: [
      step.llm({
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
    ],
    until: any(until.noToolCalls(), until.maxSteps(10)),
    inbox: opts.inbox,
    parkTimeout: opts.parkTimeout ?? 5e3,
  });
}

//#endregion
