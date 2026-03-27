/**
 * Async Sub-Agent Delegation Demo
 *
 * Shows an LLM agent launching sub-agents without blocking, continuing work,
 * and receiving results via an inbox channel when sub-agents complete.
 *
 * Flow: User input → LLM loop → launch_agent tool → sub-agent runs in background
 *       → inbox receives result → LLM synthesizes final answer
 */
import { z } from 'zod';
import { channel } from '../src/builders/channel-builder';
import { loop } from '../src/builders/loop-builder';
import { step } from '../src/builders/step-builders';
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

//#region Agent Builder

/** Builds an agent loop with async delegation via inbox channel. */
export function buildAsyncDelegateAgent(opts: {
  inbox: Channel<string>;
  parkTimeout?: number;
}): StepLoop<string, string> {
  const handles = new Map<string, DetachedHandle<string>>();

  const launchTool = createAsyncLaunchTool({
    inbox: opts.inbox,
    handles,
  });
  const checkTool = createCheckTool(handles);

  return loop({
    id: 'async-delegate-loop',
    steps: [
      step.llm({
        id: 'async-delegate-llm',
        model: 'gpt-4o',
        system: 'You are an assistant that can launch background sub-agents.',
        tools: [
          launchTool,
          checkTool,
        ],
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(10)),
    inbox: opts.inbox,
    parkTimeout: opts.parkTimeout ?? 5e3,
  });
}

//#endregion
