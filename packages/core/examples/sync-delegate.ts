/**
 * Sync Sub-Agent Delegation Demo
 *
 * Shows an LLM agent using a `delegate` tool that spawns a sub-agent
 * synchronously — the parent blocks until the child completes.
 *
 * Flow: User input → LLM loop → delegate tool call → sub-agent executes → result returned
 */

import type { ContextMemory } from '@noetic-tools/memory';
import type { StepLoop, StepSpawn } from '@noetic-tools/types';
import { react } from '../src/patterns/react';
import { createSyncDelegateTool } from './delegate-tools';

//#region Agent Builder

/** Builds the main agent loop with sync delegation capability. */
export function buildSyncDelegateAgent():
  | StepLoop<ContextMemory, string, string>
  | StepSpawn<ContextMemory, string, string> {
  const delegateTool = createSyncDelegateTool();

  return react({
    model: 'openai/gpt-4o',
    instructions: 'You are an assistant that can delegate research tasks to a sub-agent.',
    tools: [
      delegateTool,
    ],
    maxSteps: 5,
  });
}

//#endregion
