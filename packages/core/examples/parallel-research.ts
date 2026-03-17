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
import type { StepForkAll } from '../src/types/step';
import { createExampleRuntime } from './create-example-runtime';

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
export function buildParallelResearchAgent(): StepForkAll<string, string> {
  return fork<string, string>({
    id: 'parallel-research',
    mode: 'all',
    paths: () =>
      PERSPECTIVES.map((perspective) =>
        spawn<string, string>({
          id: `research-${perspective.id}`,
          child: step.llm<string, string>({
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

//#region Main

async function main(): Promise<void> {
  const runtime = createExampleRuntime();

  const agent = buildParallelResearchAgent();
  const ctx = runtime.createContext();
  const result = await runtime.execute(
    agent,
    'The impact of artificial intelligence on healthcare',
    ctx,
  );

  console.log(result);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

//#endregion
