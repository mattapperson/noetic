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
import { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { Channel } from '../src/types/channel';
import type { DetachedHandle } from '../src/types/detached';
import type { StepLoop } from '../src/types/step';
import { any } from '../src/until/combinators';
import { until } from '../src/until/predicates';
import { createAsyncLaunchTool, createCheckTool } from './delegate-tools';
import { createScriptedCallModel, textOnlyResponse, toolCallResponse } from './helpers';

//#region Inbox Channel

export const agentInbox = channel('agent-inbox', {
  schema: z.string(),
  mode: 'queue',
});

//#endregion

//#region Agent Builder

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

//#region End-to-End Execution

async function main(): Promise<void> {
  // 1. Create a mock LLM that scripts the conversation:
  //    Turn 1: LLM launches a background sub-agent
  //    Turn 2 (sub-agent): responds with research result (fires inbox notification)
  //    Turn 3: LLM receives inbox message and synthesizes final answer
  const callModel = createScriptedCallModel([
    // Parent turn 1: launches async sub-agent
    toolCallResponse({
      toolName: 'launch_agent',
      args: '{"task":"Research the population of Tokyo"}',
      output: '{"agentId":"sub-1"}',
      finalText: 'I launched a background agent to research that.',
    }),
    // Sub-agent LLM call (used by detachedSpawn internally)
    textOnlyResponse('Tokyo has a population of approximately 14 million.'),
    // Parent turn 2: after inbox delivers sub-agent result, no tool calls → loop exits
    textOnlyResponse(
      'The background agent reports: Tokyo has a population of approximately 14 million.',
    ),
  ]);

  // 2. Create runtime and context
  const runtime = new InMemoryRuntime({
    callModel,
  });
  const ctx = runtime.createContext();

  // 3. Build the agent and execute with user input
  const agent = buildAsyncDelegateAgent({
    runtime,
    inbox: agentInbox,
  });
  const userInput = 'How many people live in Tokyo?';

  console.log(`User: ${userInput}`);
  const result = await runtime.execute(agent, userInput, ctx);
  console.log(`Agent: ${result}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

//#endregion
