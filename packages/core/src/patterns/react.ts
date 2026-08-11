import type { ContextConfig, ContextData, ContextLayer } from '@noetic-tools/context';
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
 * @param opts - Model, tools, optional instructions, step/cost limits, and context layers.
 * @returns A `StepLoop` (no context layers) or `StepSpawn` wrapping a loop (with them).
 */
export function react(opts: {
  model: string;
  instructions?: string;
  tools: Tool[];
  maxSteps?: number;
  maxCost?: number;
  context?: ContextConfig | ContextLayer[];
}): StepLoop<ContextData, string, string> | StepSpawn<ContextData, string, string> {
  const llmStep = step.llm<ContextData, string, string>({
    id: 'react-step',
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.tools,
  });

  const loopStep = loop<ContextData, string, string>({
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

  const layers = opts.context;
  if (!layers) {
    return loopStep;
  }

  return spawn<ContextData, string, string>({
    id: 'react-agent',
    child: loopStep,
    context: layers,
  });
}
