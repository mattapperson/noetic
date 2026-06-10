import type { AxGEPAAdapter, AxGEPAEvaluationBatch } from '@ax-llm/ax';
import { AxGEPA, ai, ax } from '@ax-llm/ax';
import type { Step } from '@noetic-tools/core';

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

/** Produces an improved value for a single noetic field. Must never throw. */
export type ProposeFieldValueFn = (args: {
  path: string;
  currentValue: string;
  feedback: string;
}) => Promise<string>;

export interface GepaAdapterOpts {
  step: Step;
  fields: OptimizableField[];
  runEval: (step: Step) => Promise<Record<string, number>>;
  /** The ax optimizable-component id that carries the serialized fields. */
  componentId: string;
  proposeFieldValue: ProposeFieldValueFn;
}

interface ParetoPoint {
  scores: Readonly<Record<string, number>>;
  configuration: Readonly<Record<string, unknown>>;
}

//#endregion

//#region Constants

const DEFAULT_STUDENT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_TEACHER_MODEL = 'openai/gpt-4o';
const DEFAULT_NUM_TRIALS = 5;
const DEFAULT_EARLY_STOPPING = 3;
const DEFAULT_MAX_METRIC_CALLS = 10;

/**
 * The student program is a fixed single-component carrier: GEPA mutates its
 * instruction text, which holds the marker-delimited noetic field values.
 */
const STUDENT_SIGNATURE = 'currentText:string -> improvedText:string';

const FIELD_MARKER_PREFIX = '=== NOETIC FIELD ';
const FIELD_MARKER_SUFFIX = ' ===';
const FIELD_END_MARKER = '=== END NOETIC FIELD ===';

//#endregion

//#region Field Serialization

/**
 * Serialize candidate field values into a single marker-delimited text block
 * (the payload carried in the ax instruction component). Fields appear in
 * `fieldOrder`; paths absent from the candidate are skipped.
 */
export function serializeFields(candidate: Candidate, fieldOrder: ReadonlyArray<string>): string {
  const blocks: string[] = [];
  for (const path of fieldOrder) {
    const value = candidate[path];
    if (value === undefined) {
      continue;
    }
    blocks.push(
      `${FIELD_MARKER_PREFIX}${path}${FIELD_MARKER_SUFFIX}\n${value}\n${FIELD_END_MARKER}`,
    );
  }
  return blocks.join('\n');
}

/**
 * Parse marker-delimited field text back into a candidate. Returns
 * `undefined` when the text is not a faithful serialization (e.g. GEPA's
 * free-form reflection rewrote it, or a value embedded an end marker) — the
 * caller falls back to the original values rather than corrupting anything.
 */
export function parseFieldText(text: string): Candidate | undefined {
  const lines = text.split('\n');
  const parsed: Candidate = {};
  const order: string[] = [];
  let currentPath: string | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    if (currentPath === null) {
      if (line.startsWith(FIELD_MARKER_PREFIX) && line.endsWith(FIELD_MARKER_SUFFIX)) {
        currentPath = line.slice(
          FIELD_MARKER_PREFIX.length,
          line.length - FIELD_MARKER_SUFFIX.length,
        );
        buffer = [];
        continue;
      }
      return undefined;
    }
    if (line === FIELD_END_MARKER) {
      parsed[currentPath] = buffer.join('\n');
      order.push(currentPath);
      currentPath = null;
      continue;
    }
    buffer.push(line);
  }

  if (currentPath !== null || order.length === 0) {
    return undefined;
  }
  // Round-trip guard: values containing marker-like lines would have been
  // mis-split above; re-serializing and comparing catches every such case.
  if (serializeFields(parsed, order) !== text) {
    return undefined;
  }
  return parsed;
}

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

function extractFeedback(entries: ReadonlyArray<unknown> | undefined): string {
  if (!entries) {
    return '';
  }
  const parts: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const feedback = Reflect.get(entry, 'feedback');
    if (typeof feedback === 'string') {
      parts.push(feedback);
    }
  }
  return parts.join('\n');
}

/**
 * Read the serialized field text out of a pareto-point configuration.
 * On @ax-llm/ax the configuration is `{ candidate, componentMap, instruction? }`.
 */
function readCandidateText(
  configuration: Readonly<Record<string, unknown>>,
  componentId: string,
): string | undefined {
  const componentMap = configuration.componentMap;
  if (typeof componentMap === 'object' && componentMap !== null) {
    const value = Reflect.get(componentMap, componentId);
    if (typeof value === 'string') {
      return value;
    }
  }
  const instruction = configuration.instruction;
  if (typeof instruction === 'string') {
    return instruction;
  }
  return undefined;
}

function candidateFromPoint(args: {
  point: ParetoPoint;
  componentId: string;
  fields: OptimizableField[];
  initialCandidate: Candidate;
}): Candidate {
  const { point, componentId, fields, initialCandidate } = args;
  const candidate: Candidate = {
    ...initialCandidate,
  };
  const text = readCandidateText(point.configuration, componentId);
  const parsed = text !== undefined ? parseFieldText(text) : undefined;
  if (!parsed) {
    return candidate;
  }
  for (const field of fields) {
    const value = parsed[field.path];
    if (value !== undefined) {
      candidate[field.path] = value;
    }
  }
  return candidate;
}

//#endregion

//#region GEPA Adapter

export function createGepaAdapter(
  opts: GepaAdapterOpts,
): AxGEPAAdapter<EvalDatum, EvalTrajectory, Record<string, number>> {
  const { step, fields, runEval, componentId, proposeFieldValue } = opts;
  const fieldOrder = fields.map((f) => f.path);
  const initialCandidate = buildInitialCandidate(fields);

  async function safePropose(args: {
    path: string;
    currentValue: string;
    feedback: string;
  }): Promise<string> {
    try {
      const proposed = await proposeFieldValue(args);
      return proposed.length > 0 ? proposed : args.currentValue;
    } catch {
      return args.currentValue;
    }
  }

  return {
    async evaluate(
      _batch: readonly EvalDatum[],
      candidate: Readonly<Record<string, string>>,
    ): Promise<AxGEPAEvaluationBatch<EvalTrajectory, Record<string, number>>> {
      const text = candidate[componentId];
      const parsed = typeof text === 'string' ? parseFieldText(text) : undefined;
      // Destroyed/missing markers -> evaluate the original step (never a corrupted one).
      const candidateStep = parsed ? applyCandidate(step, parsed) : step;
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

    // Takes precedence over GEPA's free-form reflection, which would destroy
    // the field markers. The teacher improves each field value individually
    // and WE reassemble the marker structure.
    async propose_new_texts(
      candidate: Readonly<Record<string, string>>,
      reflectiveDataset: Readonly<Record<string, unknown[]>>,
      componentsToUpdate: readonly string[],
    ): Promise<Record<string, string>> {
      const result: Record<string, string> = {};
      for (const component of componentsToUpdate) {
        const currentText = candidate[component] ?? '';
        const parsed = parseFieldText(currentText) ?? initialCandidate;
        const feedback = extractFeedback(reflectiveDataset[component]);

        const improved: Candidate = {};
        for (const path of fieldOrder) {
          const currentValue = parsed[path] ?? initialCandidate[path] ?? '';
          improved[path] = await safePropose({
            path,
            currentValue,
            feedback,
          });
        }
        result[component] = serializeFields(improved, fieldOrder);
      }
      return result;
    },
  };
}

//#endregion

//#region Candidate Extraction

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

/**
 * Pick the pareto point with the highest average score and decode its
 * serialized field text back into a candidate. Unparseable points fall back
 * to the initial values (never corrupted output).
 */
export function extractBestCandidate(args: {
  paretoFront: ReadonlyArray<ParetoPoint>;
  fields: OptimizableField[];
  initialCandidate: Candidate;
  componentId: string;
}): {
  bestCandidate: Candidate;
  bestScore: number;
  frontier: Candidate[];
} {
  const { paretoFront, fields, initialCandidate, componentId } = args;

  if (paretoFront.length === 0) {
    return {
      bestCandidate: {
        ...initialCandidate,
      },
      bestScore: 0,
      frontier: [],
    };
  }

  let bestPoint = paretoFront[0];
  let bestScore = averageScore({
    ...bestPoint.scores,
  });
  for (const point of paretoFront.slice(1)) {
    const score = averageScore({
      ...point.scores,
    });
    if (score > bestScore) {
      bestScore = score;
      bestPoint = point;
    }
  }

  const frontier = paretoFront.map((point) =>
    candidateFromPoint({
      point,
      componentId,
      fields,
      initialCandidate,
    }),
  );

  return {
    bestCandidate: candidateFromPoint({
      point: bestPoint,
      componentId,
      fields,
      initialCandidate,
    }),
    bestScore,
    frontier,
  };
}

//#endregion

//#region GEPA Optimization

function createTeacherProposer(teacherAI: ReturnType<typeof ai>): ProposeFieldValueFn {
  const improver = ax(
    'fieldPath:string, currentValue:string, feedback:string -> improvedValue:string',
  );
  improver.setInstruction(
    'You are optimizing a single text field of an AI agent (a prompt, tool name, or tool description). ' +
      'Given the field path, its current value, and evaluation feedback, produce an improved value that ' +
      'should achieve higher eval scores. Return ONLY the improved field value.',
  );

  return async ({ path, currentValue, feedback }): Promise<string> => {
    const output = await improver.forward(teacherAI, {
      fieldPath: path,
      currentValue,
      feedback,
    });
    const improved = Reflect.get(output, 'improvedValue');
    if (typeof improved === 'string' && improved.length > 0) {
      return improved;
    }
    return currentValue;
  };
}

async function runGepaOptimization(
  params: OptimizeParams,
  apiKey: string,
  initialCandidate: Candidate,
): Promise<OptimizationResult> {
  const gepaConfig = params.gepa ?? {};
  const maxMetricCalls = params.maxMetricCalls ?? DEFAULT_MAX_METRIC_CALLS;
  const fieldOrder = params.fields.map((f) => f.path);

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

  // The instruction component carries the marker-delimited noetic fields.
  const program = ax(STUDENT_SIGNATURE);
  program.setInstruction(serializeFields(initialCandidate, fieldOrder));

  // Use the DISCOVERED component id — AxGEPA keys candidates by it.
  const instructionComponent = program
    .getOptimizableComponents()
    .find((c) => c.kind === 'instruction');
  if (!instructionComponent) {
    // No carrier component: evaluate the initial candidate once (no search).
    const scores = await params.runEval(applyCandidate(params.step, initialCandidate));
    return {
      bestCandidate: initialCandidate,
      score: averageScore(scores),
      iterations: 1,
    };
  }
  const componentId = instructionComponent.key;

  const adapter = createGepaAdapter({
    step: params.step,
    fields: params.fields,
    runEval: params.runEval,
    componentId,
    proposeFieldValue: createTeacherProposer(teacherAI),
  });

  const exampleBatch = buildExampleBatch(params.examples);
  const examples = exampleBatch.map((d) => ({
    ...d,
    currentText: params.fields[0]?.value ?? '',
    improvedText: '',
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

  const { bestCandidate, bestScore, frontier } = extractBestCandidate({
    paretoFront: result.paretoFront ?? [],
    fields: params.fields,
    initialCandidate,
    componentId,
  });

  return {
    bestCandidate,
    score: bestScore,
    iterations: Math.max(1, iterations),
    frontier,
  };
}

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
