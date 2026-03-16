/**
 * Sync Sub-Agent Delegation Demo
 *
 * Shows an LLM agent using a `delegate` tool that spawns a sub-agent
 * synchronously — the parent blocks until the child completes.
 */
import { react } from '../src/patterns/react';
import type { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { StepLoop } from '../src/types/step';
import { createExampleRuntime } from './create-example-runtime';
import { createSyncDelegateTool } from './delegate-tools';

//#region Demo Step Builder

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

//#region Main

async function main(): Promise<void> {
  const runtime = createExampleRuntime();

  const agent = buildSyncDelegateAgent(runtime);
  const ctx = runtime.createContext();
  const result = await runtime.execute(agent, 'What is the capital of France?', ctx);

  console.log(result);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

//#endregion
