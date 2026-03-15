import { spawn } from '../builders/spawn-builder';
import type { Tool } from '../types/common';
import type { StepLoop } from '../types/step';
import { any } from '../until/combinators';
import type { VerifyFn } from '../until/predicates';
import { until } from '../until/predicates';
import { react } from './react';

export function ralphWiggum(opts: {
  model: string;
  system: string;
  tools: Tool[];
  verify: VerifyFn;
  maxIterations?: number;
  innerMaxSteps?: number;
}): StepLoop<string, string> {
  const inner = react({
    model: opts.model,
    system: opts.system,
    tools: opts.tools,
    maxSteps: opts.innerMaxSteps ?? 20,
  });

  return {
    kind: 'loop',
    id: 'ralph-wiggum-loop',
    body: spawn<string, string>({
      id: 'ralph-iteration',
      child: inner,
    }),
    until: any(until.verified(opts.verify), until.maxSteps(opts.maxIterations ?? 50)),
    prepareNext: (_output, verdict) => {
      if (verdict.feedback) {
        return `Previous attempt feedback: ${verdict.feedback}\nContinue working.`;
      }
      return 'Continue working on the task.';
    },
  };
}
