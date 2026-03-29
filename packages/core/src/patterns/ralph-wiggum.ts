import { loop } from '../builders/loop-builder';
import { spawn } from '../builders/spawn-builder';
import type { Tool } from '../types/common';
import type { ContextMemory } from '../types/memory';
import type { StepLoop } from '../types/step';
import { any } from '../until/combinators';
import type { VerifyFn } from '../until/predicates';
import { until } from '../until/predicates';
import { react } from './react';

/**
 * Creates a retry-with-feedback loop wrapping a ReAct agent. Each iteration spawns an inner agent
 * and retries with verification feedback until the verifier passes or max iterations is reached.
 *
 * @public
 * @param opts - Model, tools, system prompt, verify function, and optional iteration/step limits.
 * @returns A `StepLoop` that retries the inner agent with feedback.
 */
export function ralphWiggum(opts: {
  model: string;
  system: string;
  tools: Tool[];
  verify: VerifyFn;
  maxIterations?: number;
  innerMaxSteps?: number;
}): StepLoop<ContextMemory, string, string> {
  const inner = react({
    model: opts.model,
    system: opts.system,
    tools: opts.tools,
    maxSteps: opts.innerMaxSteps ?? 20,
  });

  return loop<ContextMemory, string, string>({
    id: 'ralph-wiggum-loop',
    steps: [
      spawn<ContextMemory, string, string>({
        id: 'ralph-iteration',
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
