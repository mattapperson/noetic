import type { ContextMemory, MemoryConfig, MemoryLayer } from '@noetic-tools/memory';
import type { StepLoop, StepSpawn, Tool } from '@noetic-tools/types';
import { loop } from '../builders/loop-builder';
import { spawn } from '../builders/spawn-builder';
import { step } from '../builders/step-builders';
import { any } from '../until/combinators';
import { until } from '../until/predicates';

/**
 * Creates a ReAct (Reason + Act) agent loop: an LLM step with tools iterated until no tool calls or limits are hit.
 *
 * @public
 * @param opts - Model, tools, optional instructions, step/cost limits, and memory layers.
 * @returns A `StepLoop` (no memory) or `StepSpawn` wrapping a loop (with memory).
 */
export function react(opts: {
  model: string;
  instructions?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
  memory?: MemoryConfig | MemoryLayer[];
}): StepLoop<ContextMemory, string, string> | StepSpawn<ContextMemory, string, string> {
  const llmStep = step.llm<ContextMemory, string, string>({
    id: 'react-step',
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.tools,
  });

  const loopStep = loop<ContextMemory, string, string>({
    id: 'react-loop',
    steps: [
      llmStep,
    ],
    until: any(
      until.noToolCalls(),
      until.maxSteps(opts.maxSteps ?? 10),
      ...(opts.maxCost
        ? [
            until.maxCost(opts.maxCost),
          ]
        : []),
    ),
  });

  if (!opts.memory) {
    return loopStep;
  }

  return spawn<ContextMemory, string, string>({
    id: 'react-agent',
    child: loopStep,
    memory: opts.memory,
  });
}
