import { loop } from '../builders/loop-builder';
import { spawn } from '../builders/spawn-builder';
import { step } from '../builders/step-builders';
import type { Tool } from '../types/common';
import type { MemoryLayer } from '../types/memory';
import type { StepLoop, StepSpawn } from '../types/step';
import { any } from '../until/combinators';
import { until } from '../until/predicates';

/**
 * Creates a ReAct (Reason + Act) agent loop: an LLM step with tools iterated until no tool calls or limits are hit.
 *
 * @public
 * @param opts - Model, tools, optional system prompt, step/cost limits, and memory layers.
 * @returns A `StepLoop` (no memory) or `StepSpawn` wrapping a loop (with memory).
 */
export function react(opts: {
  model: string;
  system?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
  memory?: MemoryLayer[];
}): StepLoop<string, string> | StepSpawn<string, string> {
  const llmStep = step.llm<string, string>({
    id: 'react-step',
    model: opts.model,
    system: opts.system,
    tools: opts.tools,
  });

  const loopStep = loop({
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

  return spawn({
    id: 'react-agent',
    child: loopStep,
    memory: opts.memory,
  });
}
