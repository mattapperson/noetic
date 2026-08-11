/**
 * Shared agent compositions for the example evals.
 *
 * Both helpers are built purely from `@noetic-tools/core` public primitives
 * (`step.llm`, `loop`, `spawn`, `until`) — they demonstrate how the classic
 * ReAct and retry-with-feedback patterns compose from primitives.
 */

import type { ContextData, StepLoop, Tool, VerifyFn } from '@noetic-tools/core';
import { any, loop, spawn, step, until } from '@noetic-tools/core';

/**
 * ReAct (Reason + Act) agent loop: an LLM step with tools iterated until it
 * stops calling tools or hits the step limit.
 */
export function reactAgent(opts: {
  model: string;
  instructions?: string;
  tools: Tool[];
  maxSteps?: number;
}): StepLoop<ContextData, string, string> {
  return loop<ContextData, string, string>({
    id: 'react-loop',
    steps: [
      step.llm<ContextData, string, string>({
        id: 'react-step',
        model: opts.model,
        instructions: opts.instructions,
        tools: opts.tools,
      }),
    ],
    until: any(until.noToolCalls(), until.maxSteps(opts.maxSteps ?? 10)),
  });
}

/**
 * Retry-with-feedback loop wrapping a ReAct agent: each iteration spawns an
 * inner agent and retries with verification feedback until the verifier
 * passes or the iteration cap is reached.
 */
export function retryWithFeedback(opts: {
  model: string;
  instructions: string;
  tools: Tool[];
  verify: VerifyFn;
  maxIterations?: number;
  innerMaxSteps?: number;
}): StepLoop<ContextData, string, string> {
  const inner = reactAgent({
    model: opts.model,
    instructions: opts.instructions,
    tools: opts.tools,
    maxSteps: opts.innerMaxSteps ?? 20,
  });

  return loop<ContextData, string, string>({
    id: 'retry-with-feedback-loop',
    steps: [
      spawn<ContextData, string, string>({
        id: 'retry-iteration',
        child: inner,
      }),
    ],
    until: any(until.verified(opts.verify), until.maxSteps(opts.maxIterations ?? 50)),
    prepareNext: (_output, verdict) => {
      if (verdict.feedback) {
        return `Previous attempt feedback: ${verdict.feedback}\nContinue working.`;
      }
      return 'Continue working on the task.';
    },
  });
}
