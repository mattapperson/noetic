/**
 * Sync Sub-Agent Delegation Demo
 *
 * Shows an LLM agent using a `delegate` tool that spawns a sub-agent
 * synchronously — the parent blocks until the child completes.
 *
 * Flow: User input → LLM loop → delegate tool call → sub-agent executes → result returned
 */
import { react } from '../src/patterns/react';
import { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { StepLoop } from '../src/types/step';
import { createSyncDelegateTool } from './delegate-tools';
import { createScriptedCallModel, textOnlyResponse, toolCallResponse } from './helpers';

//#region Agent Builder

/** Builds the main agent loop with sync delegation capability. */
export function buildSyncDelegateAgent(runtime: InMemoryRuntime): StepLoop<string, string> {
  const delegateTool = createSyncDelegateTool(runtime);

  return react({
    model: 'gpt-4o',
    system: 'You are an assistant that can delegate research tasks to a sub-agent.',
    tools: [
      delegateTool,
    ],
    maxSteps: 5,
  });
}

//#endregion

//#region End-to-End Execution

async function main(): Promise<void> {
  // 1. Create a mock LLM that scripts the conversation:
  //    Turn 1: LLM calls `delegate` tool with a research task
  //    Turn 2 (sub-agent): responds with research result
  //    Turn 3: LLM synthesizes final answer (no tool calls → loop exits)
  const callModel = createScriptedCallModel([
    // Parent turn 1: decides to delegate
    toolCallResponse({
      toolName: 'delegate',
      args: '{"task":"What is the capital of France?"}',
      output: 'The capital of France is Paris.',
      finalText: 'I delegated the research task.',
    }),
    // Sub-agent response (used by the sync spawn)
    textOnlyResponse('The capital of France is Paris.'),
    // Parent turn 2: final answer with no tool calls → loop exits
    textOnlyResponse('Based on the research, the capital of France is Paris.'),
  ]);

  // 2. Create runtime and context
  const runtime = new InMemoryRuntime({
    callModel,
  });
  const ctx = runtime.createContext();

  // 3. Build the agent and execute with user input
  const agent = buildSyncDelegateAgent(runtime);
  const userInput = 'What is the capital of France?';

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
