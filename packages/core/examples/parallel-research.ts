/**
 * Parallel Research Agent
 *
 * Demonstrates: fork (all mode) + spawn + step.llm
 *
 * Forks into 3 parallel spawn-wrapped LLM calls, each researching a different
 * perspective (historical, technical, societal). Uses fork.all with a merge
 * function that combines results into a multi-section summary.
 */
import { fork } from '../src/builders/control-flow-builders';
import { spawn } from '../src/builders/spawn-builder';
import { step } from '../src/builders/step-builders';
import type { ContextMemory } from '../src/types/memory';
import type { StepForkAll } from '../src/types/step';

//#region Perspective Definitions

const PERSPECTIVES = [
  {
    id: 'historical',
    label: 'Historical Context',
    system: [
      'You are a historian.',
      'Analyze the given topic from a historical perspective.',
      'Cover key events, origins, and evolution over time.',
      'Keep your response to 2-3 paragraphs.',
    ].join(' '),
  },
  {
    id: 'technical',
    label: 'Technical Analysis',
    system: [
      'You are a technical expert.',
      'Analyze the given topic from a technical perspective.',
      'Cover mechanisms, implementations, and technical challenges.',
      'Keep your response to 2-3 paragraphs.',
    ].join(' '),
  },
  {
    id: 'societal',
    label: 'Societal Impact',
    system: [
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
export function buildParallelResearchAgent(): StepForkAll<ContextMemory, string, string> {
  return fork<ContextMemory, string, string>({
    id: 'parallel-research',
    mode: 'all',
    paths: () =>
      PERSPECTIVES.map((perspective) =>
        spawn<ContextMemory, string, string>({
          id: `research-${perspective.id}`,
          child: step.llm<ContextMemory, string, string>({
            id: `llm-${perspective.id}`,
            model: 'gpt-4o',
            system: perspective.system,
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
