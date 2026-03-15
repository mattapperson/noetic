import { step } from '../builders/step-builders';
import type { Tool } from '../types/common';
import type { StepLoop } from '../types/step';
import { any } from '../until/combinators';
import { until } from '../until/predicates';

export function react(opts: {
  model: string;
  system?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
}): StepLoop<string, string> {
  const llmStep = step.llm<string, string>({
    id: 'react-step',
    model: opts.model,
    system: opts.system,
    tools: opts.tools,
  });

  return {
    kind: 'loop',
    id: 'react-loop',
    body: llmStep,
    until: any(
      until.noToolCalls(),
      until.maxSteps(opts.maxSteps ?? 10),
      ...(opts.maxCost
        ? [
            until.maxCost(opts.maxCost),
          ]
        : []),
    ),
  };
}
