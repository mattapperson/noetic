/**
 * Sync Sub-Agent Delegation Demo
 *
 * Shows an LLM agent using a `delegate` tool that spawns a sub-agent
 * synchronously — the parent blocks until the child completes.
 *
 * Flow: User input → LLM loop → delegate tool call → sub-agent executes → result returned
 */
import { react } from '../src/patterns/react';
import type { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { StepLoop } from '../src/types/step';
import { createSyncDelegateTool } from './delegate-tools';

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
