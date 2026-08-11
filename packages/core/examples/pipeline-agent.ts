/**
 * Pipeline Agent
 *
 * Demonstrates: conditional (as sequencer) + runCode + callModel + loop + prepareNext
 *
 * A 3-stage text processing pipeline:
 * 1. runCode — normalize and clean raw text
 * 2. callModel — analyze for sentiment and themes
 * 3. runCode — format into structured report
 *
 * Uses loop({ until: until.maxSteps(3) }) with conditional routing by phase,
 * and prepareNext feeding each stage's output as the next stage's input.
 */

import type { ContextData } from '@noetic-tools/context';
import type { StepLoop } from '@noetic-tools/types';
import { conditional } from '../src/builders/control-flow-builders';
import { loop } from '../src/builders/loop-builder';
import { callModel, runCode } from '../src/builders/step-builders';
import { until } from '../src/until/predicates';

//#region Stage Handlers

const normalizeStage = runCode<ContextData, string, string>({
  id: 'normalize-text',
  execute: async (input) => {
    return input
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,!?;:'"()-]/g, '')
      .trim();
  },
});

const analyzeStage = callModel<ContextData, string, string>({
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

const formatStage = runCode<ContextData, string, string>({
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

/** Builds a 3-stage text processing pipeline using conditional + loop + prepareNext. */
export function buildPipelineAgent(): StepLoop<ContextData, string, string> {
  const stages = [
    normalizeStage,
    analyzeStage,
    formatStage,
  ] as const;
  let phase = 0;

  const router = conditional<ContextData, string, string>({
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
