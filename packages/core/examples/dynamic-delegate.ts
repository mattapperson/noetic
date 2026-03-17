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
import { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { Channel } from '../src/types/channel';
import type { DetachedHandle } from '../src/types/detached';
import type { StepLoop } from '../src/types/step';
import { any } from '../src/until/combinators';
import { until } from '../src/until/predicates';
import { createAsyncLaunchTool, createSyncDelegateTool } from './delegate-tools';
import { createScriptedCallModel, textOnlyResponse, toolCallResponse } from './helpers';

//#region Inbox Channel

export const delegateInbox = channel('delegate-inbox', {
  schema: z.string(),
  mode: 'queue',
});

//#endregion

//#region Agent Builder

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

  return loop({
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
  });
}

//#endregion

//#region End-to-End Execution

async function main(): Promise<void> {
  // 1. Create a mock LLM that scripts a conversation where the orchestrator
  //    uses sync delegation for an urgent question, then async for a background task:
  //    Turn 1: LLM calls `delegate` (sync) for a blocking question
  //    Turn 2 (sync sub-agent): answers the question
  //    Turn 3: LLM launches async agent for background research
  //    Turn 4 (async sub-agent): completes and notifies inbox
  //    Turn 5: LLM synthesizes final answer from both results
  const callModel = createScriptedCallModel([
    // Parent turn 1: sync delegate for immediate answer
    toolCallResponse({
      toolName: 'delegate',
      args: '{"task":"What year was the Eiffel Tower built?"}',
      output: 'The Eiffel Tower was completed in 1889.',
      finalText: 'Got the answer via sync delegation.',
    }),
    // Sync sub-agent LLM call
    textOnlyResponse('The Eiffel Tower was completed in 1889.'),
    // Parent turn 2: launch async agent for background research
    toolCallResponse({
      toolName: 'launch_agent',
      args: '{"task":"Find the current height of the Eiffel Tower"}',
      output: '{"agentId":"sub-height"}',
      finalText: 'Launched a background agent for additional research.',
    }),
    // Async sub-agent LLM call
    textOnlyResponse('The Eiffel Tower is 330 meters tall including antennas.'),
    // Parent turn 3: final synthesis (no tool calls → loop exits)
    textOnlyResponse(
      'The Eiffel Tower was completed in 1889 and stands 330 meters tall including antennas.',
    ),
  ]);

  // 2. Create runtime and context
  const runtime = new InMemoryRuntime({
    callModel,
  });
  const ctx = runtime.createContext();

  // 3. Build the agent and execute with user input
  const agent = buildDynamicDelegateAgent({
    runtime,
    inbox: delegateInbox,
  });
  const userInput = 'Tell me about the Eiffel Tower — when was it built and how tall is it?';

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
