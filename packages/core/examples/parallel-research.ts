/**
 * Parallel Research Agent
 *
 * Demonstrates: inParallel (all mode) + spawn + callModel
 *
 * Forks into 3 parallel spawn-wrapped LLM calls, each researching a different
 * perspective (historical, technical, societal). Uses inParallel.all with a merge
 * function that combines results into a multi-section summary.
 */

import type { ContextData } from '@noetic-tools/context';
import type { StepInParallelAll } from '@noetic-tools/types';
import { inParallel } from '../src/builders/control-flow-builders';
import { spawn } from '../src/builders/spawn-builder';
import { callModel } from '../src/builders/step-builders';

//#region Perspective Definitions

const PERSPECTIVES = [
  {
    id: 'historical',
    label: 'Historical Context',
    instructions: [
      'You are a historian.',
      'Analyze the given topic from a historical perspective.',
      'Cover key events, origins, and evolution over time.',
      'Keep your response to 2-3 paragraphs.',
    ].join(' '),
  },
  {
    id: 'technical',
    label: 'Technical Analysis',
    instructions: [
      'You are a technical expert.',
      'Analyze the given topic from a technical perspective.',
      'Cover mechanisms, implementations, and technical challenges.',
      'Keep your response to 2-3 paragraphs.',
    ].join(' '),
  },
  {
    id: 'societal',
    label: 'Societal Impact',
    instructions: [
      'You are a social scientist.',
      'Analyze the given topic from a societal perspective.',
      'Cover cultural implications, public perception, and future impact.',
      'Keep your response to 2-3 paragraphs.',
    ].join(' '),
  },
] as const;

//#endregion

//#region Agent Builder

/** Builds a parallel research agent that forks into perspective-specific sub-agents. */
export function buildParallelResearchAgent(): StepInParallelAll<ContextData, string, string> {
  return inParallel<ContextData, string, string>({
    id: 'parallel-research',
    mode: 'all',
    paths: () =>
      PERSPECTIVES.map((perspective) =>
        spawn<ContextData, string, string>({
          id: `research-${perspective.id}`,
          child: callModel<ContextData, string, string>({
            id: `llm-${perspective.id}`,
            model: 'openai/gpt-4o',
            instructions: perspective.instructions,
          }),
        }),
      ),
    merge: (results) => {
      const sections = PERSPECTIVES.map(
        (perspective, i) => `## ${perspective.label}\n\n${results[i]}`,
      );
      return `# Research Summary\n\n${sections.join('\n\n')}`;
    },
  });
}

//#endregion
