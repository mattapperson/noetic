/**
 * Live wiring of the @noetic/core `interview()` step to the chat-TUI's
 * AskUserService. Produces the `runInterview` and `askAutopilot` callables
 * that `MissionNewContainer` expects when it has access to a real harness +
 * askUserService (i.e. when invoked via `/mission new` from the chat TUI).
 *
 * The pure state-machine logic lives in `new.tsx#driveMissionNew` and is
 * tested independently. This file is the thin adapter that bridges the
 * core interview pattern's typed schemas to the askUser modal's UI shape.
 */

import type { AgentHarness, InterviewQuestionAnswer, InterviewResult } from '@noetic/core';
import { interview } from '@noetic/core';
import { z } from 'zod';

import type { AskUserInput, AskUserQuestion } from '../../../../../tools/ask-user-types.js';
import type { AskUserService } from '../../../../../tui/services/ask-user-service.js';
import { INTERVIEW_SYSTEM_PROMPT } from '../prompts.js';
import type { MissionTreeInput } from '../store.js';
import type {
  AskAutopilotFn,
  AutopilotChoice,
  InterviewQuestionEnvelope,
  InterviewResultLike,
  RunInterviewFn,
} from './new.js';

//#region Schemas

const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const QuestionSchema = z.object({
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
  acceptanceCriteria: z
    .union([
      z.array(z.string()),
      z.string(),
    ])
    .transform((v) =>
      Array.isArray(v)
        ? v
        : [
            v,
          ],
    ),
});

const SliceSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  verification: z.string(),
  features: z.array(FeatureSchema),
});

const MilestoneSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  verification: z.string(),
  slices: z.array(SliceSchema),
});

const CompleteSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  milestones: z.array(MilestoneSchema),
});

export type InterviewQuestion = z.infer<typeof QuestionSchema>;
export type InterviewComplete = z.infer<typeof CompleteSchema>;

//#endregion

//#region Adapters

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

export function toMissionTreeInput(envelope: InterviewComplete): MissionTreeInput {
  // The interview prompt instructs the model to emit the canonical
  // MissionTreeInput shape directly. CompleteSchema mirrors that shape
  // (z.union normalises acceptanceCriteria to string[]), so this is a
  // structural identity. Kept as a named export so the contract is stable
  // if the shapes ever diverge again.
  return envelope;
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
        // Persistence happens in driveMissionNew once the InterviewResult
        // bubbles back to the caller — keep onComplete a no-op here so the
        // adapter doesn't take over the host's responsibility.
      },
    });

    const ctx = args.harness.createContext({});
    const result: InterviewResult<InterviewQuestion, InterviewComplete> = await args.harness.run(
      interviewStep,
      'Tell me about the mission you want to plan.',
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
      envelope: toMissionTreeInput(result.envelope),
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
  return async (mission) => {
    const output = await args.askUserService.request({
      questions: [
        {
          question: `Enable autopilot for "${mission.title}"?`,
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
    return mapAutopilotAnswer(output.answers[`Enable autopilot for "${mission.title}"?`]);
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
