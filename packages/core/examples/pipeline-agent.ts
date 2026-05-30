/**
 * Pipeline Agent
 *
 * Demonstrates: branch (as sequencer) + step.run + step.llm + loop + prepareNext
 *
 * A 3-stage text processing pipeline:
 * 1. step.run — normalize and clean raw text
 * 2. step.llm — analyze for sentiment and themes
 * 3. step.run — format into structured report
 *
 * Uses loop({ until: until.maxSteps(3) }) with branch routing by phase,
 * and prepareNext feeding each stage's output as the next stage's input.
 */
import { branch } from '../src/builders/control-flow-builders';
import { loop } from '../src/builders/loop-builder';
import { step } from '../src/builders/step-builders';
import type { ContextMemory } from '../src/types/memory';
import type { StepLoop } from '../src/types/step';
import { until } from '../src/until/predicates';

//#region Stage Handlers

const normalizeStage = step.run<ContextMemory, string, string>({
  id: 'normalize-text',
  execute: async (input) => {
    return input
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,!?;:'"()-]/g, '')
      .trim();
  },
});

const analyzeStage = step.llm<ContextMemory, string, string>({
  id: 'analyze-text',
  model: 'openai/gpt-4o',
  instructions: [
    'You are a text analyst.',
    'Analyze the given text for sentiment (positive/negative/neutral),',
    'key themes, and notable patterns.',
    'Return your analysis as structured text with labeled sections:',
    'SENTIMENT, THEMES, PATTERNS.',
  ].join(' '),
});

const formatStage = step.run<ContextMemory, string, string>({
  id: 'format-report',
  execute: async (input) => {
    return [
      '=== Text Analysis Report ===',
      '',
      input,
      '',
      '=== End Report ===',
    ].join('\n');
  },
});

//#endregion

//#region Agent Builder

/** Builds a 3-stage text processing pipeline using branch + loop + prepareNext. */
export function buildPipelineAgent(): StepLoop<ContextMemory, string, string> {
  const stages = [
    normalizeStage,
    analyzeStage,
    formatStage,
  ] as const;
  let phase = 0;

  const router = branch<ContextMemory, string, string>({
    id: 'phase-router',
    route: () => stages[phase] ?? null,
  });

  return loop({
    id: 'pipeline-loop',
    steps: [
      router,
    ],
    until: until.maxSteps(3),
    prepareNext: (output: string): string => {
      phase++;
      return output;
    },
  });
}

//#endregion
