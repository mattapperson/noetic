/**
 * Live wiring of the @noetic/core `interview()` step to the chat-TUI's
 * AskUserService. Produces the `runInterview` and `askAutopilot` callables
 * used by the task planning flow when invoked via `/tasks plan` from the
 * chat TUI.
 *
 * The pure state-machine logic lives in the planning UI (Phase 8 owns the
 * Ink container). This file is the thin adapter that bridges the core
 * `interview()` pattern's typed schemas to the askUser modal's UI shape
 * AND persists progress in an `InterviewSession` on disk so an interrupted
 * run can be resumed.
 */

import type { AskUserService } from '@noetic/code-agent/ask-user-service';
import type { AgentHarness, InterviewQuestionAnswer, InterviewResult } from '@noetic/core';
import { interview } from '@noetic/core';
import { z } from 'zod';
import type { AskUserInput, AskUserQuestion } from '../../../../tools/ask-user-types.js';
import type { TaskStoreContext } from '../fs-store.js';
import { INTERVIEW_SYSTEM_PROMPT } from './prompts.js';
import type { InterviewSession, TaskHierarchyInput } from './schemas.js';
import { generateInterviewSessionId, InterviewSessionStatus } from './schemas.js';
import { loadInterviewSession, saveInterviewSession } from './store.js';

//#region Schemas

const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const QuestionSchema = z.object({
  id: z.string(),
  type: z.enum([
    'single_select',
    'multi_select',
    'confirm',
    'text',
  ]),
  question: z.string(),
  description: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
});

const FeatureSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  acceptanceCriteria: z.union([
    z.string(),
    z.array(z.string()),
  ]),
});

const SliceSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  verification: z.string(),
  features: z.array(FeatureSchema),
});

const AssertionSchema = z.object({
  title: z.string(),
  assertion: z.string(),
  featureIndices: z.array(z.number().int().nonnegative()),
});

const MilestoneSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  verification: z.string(),
  slices: z.array(SliceSchema),
  assertions: z.array(AssertionSchema).optional(),
});

export const CompleteSchema = z.object({
  milestones: z.array(MilestoneSchema),
});

export type InterviewQuestion = z.infer<typeof QuestionSchema>;
export type InterviewComplete = z.infer<typeof CompleteSchema>;

//#endregion

//#region Interview-flow public types

/** Question envelope passed to host-side renderers (mirrors {@link InterviewQuestion}). */
export interface InterviewQuestionEnvelope {
  id: string;
  type: 'single_select' | 'multi_select' | 'confirm' | 'text';
  question: string;
  description?: string;
  options?: ReadonlyArray<{
    id: string;
    label: string;
    description?: string;
  }>;
}

/**
 * Result shape mirrors `@noetic/core`'s `InterviewResult` but typed at the
 * higher-level envelope so call sites do not depend on the question shape.
 */
export type InterviewResultLike =
  | {
      status: 'complete';
      envelope: TaskHierarchyInput;
    }
  | {
      status: 'maxQuestions';
      lastQuestion?: InterviewQuestionEnvelope;
      reason?: string;
    };

/** Injection seam for the LLM-driven interview. */
export type RunInterviewFn = () => Promise<InterviewResultLike>;

/** Autopilot follow-up answer. */
export type AutopilotChoice = 'yes' | 'no' | 'first-slice-only';

/** Injection seam for the autopilot follow-up prompt. */
export type AskAutopilotFn = (taskTitle: string) => Promise<AutopilotChoice>;

//#endregion

//#region Adapter helpers

const CONFIRM_YES = 'Yes';
const CONFIRM_NO = 'No';

function clampOptions<T>(items: ReadonlyArray<T>, max: number): T[] {
  return items.slice(0, max);
}

export function buildAskUserQuestion(envelope: InterviewQuestion): AskUserQuestion {
  const baseHeader = envelope.id.length > 12 ? envelope.id.slice(0, 12) : envelope.id;
  if (envelope.type === 'confirm') {
    return {
      question: envelope.question,
      header: baseHeader.length > 0 ? baseHeader : 'Confirm',
      multiSelect: false,
      options: [
        {
          label: CONFIRM_YES,
          description: 'Yes',
        },
        {
          label: CONFIRM_NO,
          description: 'No',
        },
      ],
    };
  }
  if (envelope.type === 'text' || (envelope.options ?? []).length === 0) {
    return {
      question: envelope.question,
      header: baseHeader.length > 0 ? baseHeader : 'Answer',
      multiSelect: false,
      options: [
        {
          label: 'Provide answer',
          description: 'Enter a free-text response.',
        },
        {
          label: 'Skip',
          description: 'Decline to answer this question.',
        },
      ],
    };
  }
  const trimmedOptions = clampOptions(envelope.options ?? [], 4);
  return {
    question: envelope.question,
    header: baseHeader.length > 0 ? baseHeader : 'Choose',
    multiSelect: envelope.type === 'multi_select',
    options: trimmedOptions.map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
    })),
  };
}

export function extractAnswer(
  envelope: InterviewQuestion,
  output: {
    answers: Record<string, string>;
  },
): InterviewQuestionAnswer {
  const raw = output.answers[envelope.question] ?? '';
  if (envelope.type === 'multi_select') {
    const parts = raw
      .split(/\s*,\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return {
      questionId: envelope.id,
      question: envelope.question,
      answer: parts,
    };
  }
  return {
    questionId: envelope.id,
    question: envelope.question,
    answer: raw,
  };
}

/**
 * Normalise the interview's complete envelope into the canonical
 * `TaskHierarchyInput`. `acceptanceCriteria` may arrive as a string or
 * a string array — for the new schema we collapse it to the first
 * non-empty entry (or the original string) so downstream
 * `persistTaskHierarchy` sees a single field.
 */
export function toTaskHierarchyInput(envelope: InterviewComplete): TaskHierarchyInput {
  return {
    milestones: envelope.milestones.map((milestone) => ({
      title: milestone.title,
      description: milestone.description ?? null,
      verification: milestone.verification,
      slices: milestone.slices.map((slice) => ({
        title: slice.title,
        description: slice.description ?? null,
        verification: slice.verification,
        features: slice.features.map((feature) => ({
          title: feature.title,
          description: feature.description ?? null,
          acceptanceCriteria: collapseAcceptanceCriteria(feature.acceptanceCriteria),
        })),
      })),
      assertions: (milestone.assertions ?? []).map((assertion) => ({
        title: assertion.title,
        assertion: assertion.assertion,
        featureIndices: assertion.featureIndices,
      })),
    })),
  };
}

function collapseAcceptanceCriteria(value: string | string[]): string {
  if (typeof value === 'string') {
    return value;
  }
  return value.filter((entry) => entry.trim().length > 0).join('\n');
}

function toMaxQuestionsEnvelope(
  lastQuestion: InterviewQuestion | undefined,
): InterviewQuestionEnvelope | undefined {
  if (lastQuestion === undefined) {
    return undefined;
  }
  return {
    id: lastQuestion.id,
    type: lastQuestion.type,
    question: lastQuestion.question,
    description: lastQuestion.description,
    options: lastQuestion.options,
  };
}

//#endregion

//#region Session persistence

/** Create or reuse an open interview session for a task. */
export async function ensureInterviewSession(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<InterviewSession> {
  const now = new Date().toISOString();
  const session: InterviewSession = {
    id: generateInterviewSessionId(),
    taskId,
    status: InterviewSessionStatus.Active,
    state: {},
    createdAt: now,
    updatedAt: now,
  };
  await saveInterviewSession(ctx, taskId, session);
  return session;
}

/** Mark a session terminal (complete or cancelled) with a structured payload. */
export async function closeInterviewSession(
  ctx: TaskStoreContext,
  args: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly status: 'complete' | 'cancelled';
    readonly state?: Record<string, unknown>;
  },
): Promise<InterviewSession> {
  const existing = await loadInterviewSession(ctx, args.taskId, args.sessionId);
  if (existing === null) {
    throw new Error(`Interview session ${args.sessionId} not found for task ${args.taskId}`);
  }
  const next: InterviewSession = {
    ...existing,
    status:
      args.status === 'complete'
        ? InterviewSessionStatus.Complete
        : InterviewSessionStatus.Cancelled,
    state: args.state ?? existing.state,
    updatedAt: new Date().toISOString(),
  };
  await saveInterviewSession(ctx, args.taskId, next);
  return next;
}

//#endregion

//#region Public API

export interface CreateLiveInterviewArgs {
  harness: AgentHarness;
  askUserService: AskUserService;
  model: string;
  /** Maximum question turns before the loop bails to `maxQuestions`. Default 8. */
  maxQuestions?: number;
}

/**
 * Build a `RunInterviewFn` that runs `interview()` against the live harness
 * and pipes each question through `askUserService.request()`.
 */
export function createLiveRunInterview(args: CreateLiveInterviewArgs): RunInterviewFn {
  return async () => {
    const interviewStep = interview<InterviewQuestion, InterviewComplete>({
      systemPrompt: INTERVIEW_SYSTEM_PROMPT,
      model: args.model,
      questionSchema: QuestionSchema,
      completeSchema: CompleteSchema,
      maxQuestions: args.maxQuestions ?? 8,
      askQuestion: async (envelope) => {
        const askInput: AskUserInput = {
          questions: [
            buildAskUserQuestion(envelope),
          ],
        };
        const output = await args.askUserService.request(askInput);
        return extractAnswer(envelope, output);
      },
      onComplete: async () => {
        // Persistence is the host's responsibility — surfacing the envelope
        // back to the caller keeps the adapter pure.
      },
    });

    const ctx = args.harness.createContext({});
    const result: InterviewResult<InterviewQuestion, InterviewComplete> = await args.harness.run(
      interviewStep,
      'Tell me about the task you want to plan.',
      ctx,
    );
    return toInterviewResultLike(result);
  };
}

export function toInterviewResultLike(
  result: InterviewResult<InterviewQuestion, InterviewComplete>,
): InterviewResultLike {
  if (result.status === 'complete') {
    return {
      status: 'complete',
      envelope: toTaskHierarchyInput(result.envelope),
    };
  }
  return {
    status: 'maxQuestions',
    lastQuestion: toMaxQuestionsEnvelope(result.lastQuestion),
    reason: 'Interview reached its question budget without producing a complete plan.',
  };
}

export interface CreateAskAutopilotArgs {
  askUserService: AskUserService;
}

/** Build an `AskAutopilotFn` backed by the askUser modal. */
export function createAskAutopilot(args: CreateAskAutopilotArgs): AskAutopilotFn {
  return async (taskTitle: string) => {
    const question = `Enable autopilot for "${taskTitle}"?`;
    const output = await args.askUserService.request({
      questions: [
        {
          question,
          header: 'Autopilot',
          multiSelect: false,
          options: [
            {
              label: 'Yes',
              description: 'The daemon triages and runs every slice automatically.',
            },
            {
              label: 'First slice only',
              description: 'Triage just the first slice; pause autopilot after.',
            },
            {
              label: 'No',
              description: 'Leave autopilot off; activate slices manually.',
            },
          ],
        },
      ],
    });
    return mapAutopilotAnswer(output.answers[question]);
  };
}

export function mapAutopilotAnswer(raw: string | undefined): AutopilotChoice {
  if (raw === 'Yes') {
    return 'yes';
  }
  if (raw === 'First slice only') {
    return 'first-slice-only';
  }
  return 'no';
}

//#endregion
