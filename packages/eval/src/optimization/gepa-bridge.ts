import type { AxGEPAAdapter, AxGEPAEvaluationBatch } from '@ax-llm/ax';
import { AxGEPA, ai, ax } from '@ax-llm/ax';
import type { Step } from '@noetic/core';

import type { Candidate, OptimizableField, OptimizationResult } from '../types/optimizer';
import { averageNumbers } from '../utils/scores';
import { applyCandidate } from './mutator';

//#region Types

export interface GepaConfig {
  studentModel?: string;
  teacherModel?: string;
  numTrials?: number;
  earlyStoppingTrials?: number;
  verbose?: boolean;
}

export interface OptimizeParams {
  step: Step;
  fields: OptimizableField[];
  runEval: (step: Step) => Promise<Record<string, number>>;
  examples?: ReadonlyArray<Record<string, unknown>>;
  maxMetricCalls?: number;
  budget?: number;
  gepa?: GepaConfig;
}

interface EvalDatum {
  index: number;
}

interface EvalTrajectory {
  scores: Record<string, number>;
}

//#endregion

//#region Constants

const DEFAULT_STUDENT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_TEACHER_MODEL = 'openai/gpt-4o';
const DEFAULT_NUM_TRIALS = 5;
const DEFAULT_EARLY_STOPPING = 3;
const DEFAULT_MAX_METRIC_CALLS = 10;

//#endregion

//#region Helper Functions

function buildInitialCandidate(fields: OptimizableField[]): Candidate {
  const candidate: Candidate = {};
  for (const field of fields) {
    candidate[field.path] = field.value;
  }
  return candidate;
}

function averageScore(scores: Record<string, number>): number {
  return averageNumbers(Object.values(scores));
}

function createAiService(model: string, apiKey: string): ReturnType<typeof ai> {
  return ai({
    name: 'openrouter',
    apiKey,
    config: {
      model,
    },
  });
}

function buildExampleBatch(
  examples: ReadonlyArray<Record<string, unknown>> | undefined,
): EvalDatum[] {
  if (!examples || examples.length < 2) {
    // AxGEPA requires at least 2 examples for train/validation split
    return [
      {
        index: 0,
      },
      {
        index: 1,
      },
    ];
  }
  return examples.map((_, i) => ({
    index: i,
  }));
}

function createGepaAdapter(
  step: Step,
  runEval: (step: Step) => Promise<Record<string, number>>,
): AxGEPAAdapter<EvalDatum, EvalTrajectory, Record<string, number>> {
  return {
    async evaluate(
      _batch: readonly EvalDatum[],
      candidate: Readonly<Record<string, string>>,
    ): Promise<AxGEPAEvaluationBatch<EvalTrajectory, Record<string, number>>> {
      const candidateStep = applyCandidate(step, candidate);
      const scores = await runEval(candidateStep);
      const avg = averageScore(scores);

      return {
        outputs: [
          scores,
        ],
        scores: [
          avg,
        ],
        trajectories: [
          {
            scores,
          },
        ],
      };
    },

    make_reflective_dataset(
      candidate: Readonly<Record<string, string>>,
      evalBatch: Readonly<AxGEPAEvaluationBatch<EvalTrajectory, Record<string, number>>>,
      componentsToUpdate: readonly string[],
    ): Record<string, unknown[]> {
      const dataset: Record<string, unknown[]> = {};

      for (const component of componentsToUpdate) {
        const currentValue = candidate[component] ?? '';
        const scores = evalBatch.trajectories?.[0]?.scores ?? {};
        const avgScore = evalBatch.scores[0] ?? 0;

        dataset[component] = [
          {
            currentText: currentValue,
            scores,
            averageScore: avgScore,
            feedback: `Current score: ${avgScore.toFixed(2)}. Improve this text to achieve higher eval scores.`,
          },
        ];
      }

      return dataset;
    },
  };
}

function buildAxGenSignature(fields: OptimizableField[]): string {
  const fieldNames = fields.map((_f, i) => `field${i}:string`);
  return `${fieldNames.join(', ')} -> improved:string`;
}

function extractPredictionScores(
  args: Readonly<{
    prediction: unknown;
    example: unknown;
  }>,
): Record<string, number> {
  const pred = args.prediction;
  if (!pred || typeof pred !== 'object' || Array.isArray(pred)) {
    return {
      score: 0,
    };
  }
  const scores: Record<string, number> = {};
  for (const [key, val] of Object.entries(pred)) {
    if (typeof val === 'number') {
      scores[key] = val;
    }
  }
  return Object.keys(scores).length > 0
    ? scores
    : {
        score: 0,
      };
}

function extractBestCandidate(
  paretoFront: ReadonlyArray<{
    scores: Readonly<Record<string, number>>;
    configuration: Readonly<Record<string, unknown>>;
  }>,
  fields: OptimizableField[],
  initialCandidate: Candidate,
): {
  bestCandidate: Candidate;
  bestScore: number;
  frontier: Candidate[];
} {
  const bestCandidate: Candidate = {
    ...initialCandidate,
  };

  if (paretoFront.length === 0) {
    return {
      bestCandidate,
      bestScore: 0,
      frontier: [],
    };
  }

  const bestPoint = paretoFront[0];
  for (const field of fields) {
    const configValue = bestPoint.configuration[field.path];
    if (typeof configValue === 'string') {
      bestCandidate[field.path] = configValue;
    }
  }

  const frontier = paretoFront.map((p) => {
    const c: Candidate = {};
    for (const field of fields) {
      const val = p.configuration[field.path];
      c[field.path] = typeof val === 'string' ? val : initialCandidate[field.path];
    }
    return c;
  });

  return {
    bestCandidate,
    bestScore: averageScore(bestPoint.scores),
    frontier,
  };
}

async function runGepaOptimization(
  params: OptimizeParams,
  apiKey: string,
  initialCandidate: Candidate,
): Promise<OptimizationResult> {
  const gepaConfig = params.gepa ?? {};
  const maxMetricCalls = params.maxMetricCalls ?? DEFAULT_MAX_METRIC_CALLS;

  const studentAI = createAiService(gepaConfig.studentModel ?? DEFAULT_STUDENT_MODEL, apiKey);
  const teacherAI = createAiService(gepaConfig.teacherModel ?? DEFAULT_TEACHER_MODEL, apiKey);

  const optimizer = new AxGEPA({
    studentAI,
    teacherAI,
    numTrials: gepaConfig.numTrials ?? DEFAULT_NUM_TRIALS,
    earlyStoppingTrials: gepaConfig.earlyStoppingTrials ?? DEFAULT_EARLY_STOPPING,
    minibatch: false,
    sampleCount: 1,
    verbose: gepaConfig.verbose ?? false,
  });

  const adapter = createGepaAdapter(params.step, params.runEval);
  const program = ax(buildAxGenSignature(params.fields));
  program.setInstruction(params.fields.map((f) => `[${f.path}]: ${f.value}`).join('\n'));

  const exampleBatch = buildExampleBatch(params.examples);
  const examples = exampleBatch.map((d) => ({
    ...d,
    field0: params.fields[0]?.value ?? '',
    improved: '',
  }));
  const validationExamples = examples.slice(0, Math.max(1, Math.floor(examples.length / 2)));

  let iterations = 0;
  const result = await optimizer.compile(program, examples, extractPredictionScores, {
    gepaAdapter: adapter,
    maxMetricCalls,
    validationExamples,
    verbose: gepaConfig.verbose ?? false,
    overrideOnProgress: () => {
      iterations++;
    },
  });

  const { bestCandidate, bestScore, frontier } = extractBestCandidate(
    result.paretoFront ?? [],
    params.fields,
    initialCandidate,
  );

  return {
    bestCandidate,
    score: bestScore,
    iterations: Math.max(1, iterations),
    frontier,
  };
}

//#endregion

//#region Public API

export async function optimizeWithGepa(params: OptimizeParams): Promise<OptimizationResult> {
  const initialCandidate = buildInitialCandidate(params.fields);

  if (params.fields.length === 0) {
    return {
      bestCandidate: initialCandidate,
      score: 0,
      iterations: 0,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const candidateStep = applyCandidate(params.step, initialCandidate);
    const scores = await params.runEval(candidateStep);
    return {
      bestCandidate: initialCandidate,
      score: averageScore(scores),
      iterations: 1,
    };
  }

  return runGepaOptimization(params, apiKey, initialCandidate);
}

//#endregion
