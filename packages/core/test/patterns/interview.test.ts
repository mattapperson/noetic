import { describe, expect, it } from 'bun:test';
import type { LLMResponse, MessageItem } from '@noetic-tools/types';
import { z } from 'zod';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { InterviewQuestionAnswer } from '../../src/patterns/interview';
import { interview } from '../../src/patterns/interview';
import { createScriptedCallModel } from '../_helpers';

//#region Schemas / fixtures

const QuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
});

const CompleteSchema = z.object({
  summary: z.string(),
  fields: z.record(z.string(), z.string()),
});

type QuestionEnv = z.infer<typeof QuestionSchema>;
type CompleteEnv = z.infer<typeof CompleteSchema>;

function makeJsonResponse(payload: unknown): LLMResponse {
  return {
    items: [
      {
        id: `msg-${Math.random().toString(36).slice(2)}`,
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify(payload),
          },
        ],
      } satisfies MessageItem,
    ],
    usage: {
      inputTokens: 10,
      outputTokens: 10,
    },
  };
}

function questionResponse(id: string, prompt: string): LLMResponse {
  return makeJsonResponse({
    type: 'question',
    data: {
      id,
      prompt,
    },
  });
}

function completeResponse(env: CompleteEnv): LLMResponse {
  return makeJsonResponse({
    type: 'complete',
    data: env,
  });
}

interface AnswerQueueItem {
  questionId: string;
  question: string;
  answer: string | string[];
  notes?: string;
}

function makeAskQuestion(answers: AnswerQueueItem[]): {
  ask: (env: QuestionEnv) => Promise<InterviewQuestionAnswer>;
  calls: Array<{
    env: QuestionEnv;
    returned: InterviewQuestionAnswer;
  }>;
} {
  const queue = [
    ...answers,
  ];
  const calls: Array<{
    env: QuestionEnv;
    returned: InterviewQuestionAnswer;
  }> = [];
  return {
    ask: async (env) => {
      const next = queue.shift();
      if (!next) {
        throw new Error('answer queue exhausted');
      }
      const returned: InterviewQuestionAnswer = {
        questionId: next.questionId,
        question: next.question,
        answer: next.answer,
        notes: next.notes,
      };
      calls.push({
        env,
        returned,
      });
      return returned;
    },
    calls,
  };
}

//#endregion

describe('interview pattern', () => {
  it('produces a tree wrapping a loop with a single body step', () => {
    const ask = makeAskQuestion([]);
    const interviewStep = interview<QuestionEnv, CompleteEnv>({
      systemPrompt: 'You are a planner.',
      model: 'gpt-4',
      questionSchema: QuestionSchema,
      completeSchema: CompleteSchema,
      askQuestion: ask.ask,
      onComplete: async () => {},
    });
    expect(interviewStep.kind).toBe('run');
    expect(interviewStep.id).toBe('interview');
  });

  it('emits questions, threads answers back, terminates on complete envelope', async () => {
    const ask = makeAskQuestion([
      {
        questionId: 'q1',
        question: 'name?',
        answer: 'Ada',
      },
      {
        questionId: 'q2',
        question: 'goal?',
        answer: 'ship oauth',
      },
    ]);

    const completionEnv: CompleteEnv = {
      summary: 'OAuth shipping',
      fields: {
        name: 'Ada',
        goal: 'ship oauth',
      },
    };
    const completionPayloads: CompleteEnv[] = [];

    const script: LLMResponse[] = [
      questionResponse('q1', 'name?'),
      questionResponse('q2', 'goal?'),
      completeResponse(completionEnv),
    ];

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const interviewStep = interview<QuestionEnv, CompleteEnv>({
      systemPrompt: 'You are a planner.',
      model: 'gpt-4',
      questionSchema: QuestionSchema,
      completeSchema: CompleteSchema,
      askQuestion: ask.ask,
      onComplete: async (env) => {
        completionPayloads.push(env);
      },
    });

    const result = await harness.run(interviewStep, 'I want to ship oauth.', ctx);

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') {
      throw new Error('expected complete result');
    }
    expect(result.envelope).toEqual(completionEnv);
    expect(completionPayloads).toEqual([
      completionEnv,
    ]);
    expect(ask.calls).toHaveLength(2);
    expect(ask.calls[0].env.id).toBe('q1');
    expect(ask.calls[1].env.id).toBe('q2');

    // Side effects on Context: itemLog grew + tokens accumulated.
    expect(ctx.itemLog.items.length).toBeGreaterThan(0);
    expect(ctx.tokens.total).toBeGreaterThan(0);
  });

  it('terminates gracefully with maxQuestions when no complete envelope arrives', async () => {
    const ask = makeAskQuestion([
      {
        questionId: 'q1',
        question: 'q1?',
        answer: 'a1',
      },
      {
        questionId: 'q2',
        question: 'q2?',
        answer: 'a2',
      },
    ]);

    const completionPayloads: CompleteEnv[] = [];

    const script: LLMResponse[] = [
      questionResponse('q1', 'q1?'),
      questionResponse('q2', 'q2?'),
    ];

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const interviewStep = interview<QuestionEnv, CompleteEnv>({
      systemPrompt: 'You are a planner.',
      model: 'gpt-4',
      questionSchema: QuestionSchema,
      completeSchema: CompleteSchema,
      askQuestion: ask.ask,
      onComplete: async (env) => {
        completionPayloads.push(env);
      },
      maxQuestions: 2,
    });

    const result = await harness.run(interviewStep, 'go', ctx);

    expect(result.status).toBe('maxQuestions');
    if (result.status !== 'maxQuestions') {
      throw new Error('expected maxQuestions result');
    }
    expect(result.lastQuestion?.id).toBe('q2');
    expect(completionPayloads).toEqual([]);
    expect(ask.calls).toHaveLength(2);
  });

  it('uses formatAnswer override when threading the next user message', async () => {
    const ask = makeAskQuestion([
      {
        questionId: 'q1',
        question: 'name?',
        answer: 'Ada',
      },
    ]);

    const formatted: string[] = [];

    const completionEnv: CompleteEnv = {
      summary: 'done',
      fields: {},
    };

    const script: LLMResponse[] = [
      questionResponse('q1', 'name?'),
      completeResponse(completionEnv),
    ];

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const interviewStep = interview<QuestionEnv, CompleteEnv>({
      systemPrompt: 'sys',
      model: 'gpt-4',
      questionSchema: QuestionSchema,
      completeSchema: CompleteSchema,
      askQuestion: ask.ask,
      onComplete: async () => {},
      formatAnswer: (a) => {
        const formattedString = `ANS:${a.questionId}=${String(a.answer)}`;
        formatted.push(formattedString);
        return formattedString;
      },
    });

    const result = await harness.run(interviewStep, 'go', ctx);
    expect(result.status).toBe('complete');
    expect(formatted).toEqual([
      'ANS:q1=Ada',
    ]);
    // The formatted answer should have been appended as a user message between turns.
    const userTexts = ctx.itemLog.items
      .filter((it) => it.type === 'message')
      .flatMap((it) => {
        if (it.type !== 'message') {
          return [];
        }
        return it.content
          .map((part) => ('text' in part ? part.text : ''))
          .filter((t) => typeof t === 'string');
      });
    expect(userTexts).toContain('ANS:q1=Ada');
  });
});
