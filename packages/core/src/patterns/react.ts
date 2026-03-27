import { loop } from '../builders/loop-builder';
import { spawn } from '../builders/spawn-builder';
import { step } from '../builders/step-builders';
import type { Tool } from '../types/common';
import type { MemoryLayer } from '../types/memory';
import type { StepLoop, StepSpawn } from '../types/step';
import { any } from '../until/combinators';
import { until } from '../until/predicates';

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
