import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { CallModelRequest, DecideRequest, LLMResponse } from '@noetic-tools/types';
import { DecideOutputError, frameworkCast } from '@noetic-tools/types';
import type { DecisionsClient } from '../../src/harness/decide-call';
import { callDecide } from '../../src/harness/decide-call';
import { makeLLMResponse } from '../_helpers';

//#region Helpers

const REQUEST: DecideRequest = {
  model: 'typesafe/jev-1.14',
  instructions: 'Support triage.',
  state: [
    {
      type: 'text',
      name: 'input',
      text: 'My screen arrived broken.',
    },
    {
      type: 'text',
      text: 'user: refund please',
    },
    {
      type: 'json',
      name: 'plan',
      value: 'pro',
    },
  ],
  questions: {
    damaged: {
      type: 'boolean',
      instructions: 'Is the item damaged?',
      criteria: {
        true: 'Damaged',
        false: 'Intact',
      },
      threshold: 0.7,
    },
    queue: {
      type: 'choice',
      instructions: 'Which team?',
      choices: {
        billing: 'Refunds',
        shipping: 'Delivery',
      },
    },
    urgency: {
      type: 'score',
      levels: [
        {
          label: 'low',
          description: 'Can wait',
        },
        {
          label: 'medium',
        },
        {
          label: 'high',
        },
      ],
    },
  },
};

interface FakeClient {
  client: DecisionsClient;
  sent: unknown[];
  lookups: string[];
}

function fakeClient(opts: { modality: string; answers: Record<string, unknown> }): FakeClient {
  const sent: unknown[] = [];
  const lookups: string[] = [];
  const client = frameworkCast<DecisionsClient>({
    models: {
      get: async (req: { author: string; slug: string }) => {
        lookups.push(`${req.author}/${req.slug}`);
        return {
          data: {
            architecture: {
              outputModalities: [
                opts.modality,
              ],
            },
          },
        };
      },
    },
    alpha: {
      decisions: {
        create: async (req: unknown) => {
          sent.push(req);
          return {
            answers: opts.answers,
            model: 'typesafe/jev-1.14-20261014',
            usage: {
              inputTokens: 397,
              outputTokens: 63,
              cost: 0.000016674,
            },
          };
        },
      },
    },
  });
  return {
    client,
    sent,
    lookups,
  };
}

const NATIVE_ANSWERS = {
  damaged: {
    type: 'noul',
    noul: 0.99,
  },
  queue: {
    type: 'choice',
    choice: 'billing',
    confidence: 0.2,
    probabilities: {
      billing: 0.6,
      shipping: 0.4,
    },
  },
  urgency: {
    type: 'score',
    score: 1.43,
    confidence: 0.32,
    probabilities: {
      '0': 0.01,
      '1': 0.55,
      '2': 0.44,
    },
  },
};

function noChatModel(): (request: CallModelRequest) => Promise<LLMResponse> {
  return async () => {
    throw new Error('the native path must not call the chat model');
  };
}

function scriptedChat(texts: string[]): {
  callModel: (request: CallModelRequest) => Promise<LLMResponse>;
  requests: CallModelRequest[];
} {
  const requests: CallModelRequest[] = [];
  let i = 0;
  return {
    requests,
    callModel: async (request) => {
      requests.push(request);
      const text = texts[i++];
      assert(text !== undefined, 'chat script exhausted');
      return makeLLMResponse(text);
    },
  };
}

//#endregion

describe('callDecide — native path', () => {
  it('translates questions and state into the TypeSafe wire format', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: NATIVE_ANSWERS,
    });
    await callDecide(REQUEST, {
      client: fake.client,
      callModel: noChatModel(),
      nativeModels: new Map(),
    });

    expect(fake.sent[0]).toEqual({
      decisionsRequest: {
        model: 'typesafe/jev-1.14',
        state: {
          instructions: 'Support triage.',
          input: 'My screen arrived broken.',
          plan: 'pro',
          conversation: [
            'user: refund please',
          ],
        },
        questions: {
          damaged: {
            type: 'noul',
            instructions: 'Is the item damaged?',
            criteria: {
              true: 'Damaged',
              false: 'Intact',
            },
          },
          queue: {
            type: 'choice',
            instructions: 'Which team?',
            criteria: {
              billing: 'Refunds',
              shipping: 'Delivery',
            },
          },
          urgency: {
            type: 'score',
            instructions: 'Place the state on this scale.',
            criteria: [
              'low: Can wait',
              'medium',
              'high',
            ],
          },
        },
      },
    });
  });

  it('maps answers back: noul by threshold, score probabilities from level index to label', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: NATIVE_ANSWERS,
    });
    const response = await callDecide(REQUEST, {
      client: fake.client,
      callModel: noChatModel(),
      nativeModels: new Map(),
    });

    expect(response.source).toBe('native');
    expect(response.modelId).toBe('typesafe/jev-1.14-20261014');
    expect(response.cost).toBeCloseTo(0.000016674);
    expect(response.answers).toEqual({
      damaged: {
        type: 'boolean',
        value: true,
        probability: 0.99,
      },
      queue: {
        type: 'choice',
        value: 'billing',
        confidence: 0.2,
        probabilities: {
          billing: 0.6,
          shipping: 0.4,
        },
      },
      urgency: {
        type: 'score',
        value: 1.43,
        level: 'medium',
        confidence: 0.32,
        probabilities: {
          low: 0.01,
          medium: 0.55,
          high: 0.44,
        },
      },
    });
  });

  it('maps an explicit refusal to Refusal, and leaves a missing or mistyped answer out for validation to catch', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: {
        // The SDK parses answer types it does not model into `UNKNOWN`, keeping the payload.
        damaged: {
          type: 'UNKNOWN',
          isUnknown: true,
          raw: {
            type: 'refusal',
          },
        },
        queue: {
          type: 'score',
          score: 1,
        },
      },
    });
    const response = await callDecide(REQUEST, {
      client: fake.client,
      callModel: noChatModel(),
      nativeModels: new Map(),
    });
    expect(response.answers.damaged).toEqual({
      type: 'refusal',
    });
    expect('queue' in response.answers).toBe(false);
    expect('urgency' in response.answers).toBe(false);
  });

  it('gives a choice a probability for every option, even when the provider sends none', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: {
        ...NATIVE_ANSWERS,
        queue: {
          type: 'choice',
          choice: 'shipping',
        },
      },
    });
    const response = await callDecide(REQUEST, {
      client: fake.client,
      callModel: noChatModel(),
      nativeModels: new Map(),
    });
    expect(response.answers.queue).toEqual({
      type: 'choice',
      value: 'shipping',
      confidence: 1,
      probabilities: {
        billing: 0,
        shipping: 1,
      },
    });
  });

  it('picks the score level by rounding when no distribution comes back', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: {
        ...NATIVE_ANSWERS,
        urgency: {
          type: 'score',
          score: 1.6,
        },
      },
    });
    const response = await callDecide(REQUEST, {
      client: fake.client,
      callModel: noChatModel(),
      nativeModels: new Map(),
    });
    const urgency = response.answers.urgency;
    assert(urgency?.type === 'score');
    expect(urgency.level).toBe('high');
  });

  it('folds a one-sided boolean criteria into instructions', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: {},
    });
    await callDecide(
      {
        model: 'typesafe/jev-1.14',
        state: [],
        questions: {
          spam: {
            type: 'boolean',
            criteria: {
              true: 'Unsolicited marketing',
            },
          },
          late: {
            type: 'boolean',
            instructions: 'Is the parcel late?',
            criteria: {
              false: 'Arrived on time.',
            },
          },
        },
      },
      {
        client: fake.client,
        callModel: noChatModel(),
        nativeModels: new Map(),
      },
    );
    expect(fake.sent[0]).toMatchObject({
      decisionsRequest: {
        questions: {
          spam: {
            type: 'noul',
            instructions: 'Yes means: Unsolicited marketing',
          },
          late: {
            type: 'noul',
            instructions: 'Is the parcel late? No means: Arrived on time.',
          },
        },
      },
    });
  });

  it('asks again after a failed model lookup instead of pinning the estimated path', async () => {
    let lookups = 0;
    const fake = fakeClient({
      modality: 'decisions',
      answers: NATIVE_ANSWERS,
    });
    const flaky = frameworkCast<DecisionsClient>({
      ...fake.client,
      models: {
        get: async (req: { author: string; slug: string }) => {
          lookups++;
          if (lookups === 1) {
            throw Object.assign(new Error('gateway timeout'), {
              statusCode: 504,
            });
          }
          return fake.client.models.get(req);
        },
      },
    });
    const chat = scriptedChat([
      JSON.stringify({
        damaged: {
          yes: 0.9,
        },
        queue: {
          billing: 1,
          shipping: 0,
        },
        urgency: {
          low: 1,
          medium: 0,
          high: 0,
        },
      }),
    ]);
    const deps = {
      client: flaky,
      callModel: chat.callModel,
      nativeModels: new Map<string, Promise<boolean | undefined>>(),
    };
    expect((await callDecide(REQUEST, deps)).source).toBe('estimated');
    await Promise.resolve();
    expect((await callDecide(REQUEST, deps)).source).toBe('native');
    expect(lookups).toBe(2);
  });

  it('looks up each model once per harness', async () => {
    const fake = fakeClient({
      modality: 'decisions',
      answers: NATIVE_ANSWERS,
    });
    const deps = {
      client: fake.client,
      callModel: noChatModel(),
      nativeModels: new Map<string, Promise<boolean | undefined>>(),
    };
    await callDecide(REQUEST, deps);
    await callDecide(REQUEST, deps);
    expect(fake.lookups).toEqual([
      'typesafe/jev-1.14',
    ]);
  });
});

describe('callDecide — estimated path', () => {
  it('takes the estimated path for a text model and normalizes choice and score probabilities', async () => {
    const fake = fakeClient({
      modality: 'text',
      answers: {},
    });
    const chat = scriptedChat([
      JSON.stringify({
        damaged: {
          yes: 0.65,
        },
        queue: {
          billing: 0.6,
          shipping: 0.2,
        },
        urgency: {
          low: 0,
          medium: 0,
          high: 0.5,
        },
      }),
    ]);
    const response = await callDecide(
      {
        ...REQUEST,
        model: 'openai/gpt-4o-mini',
      },
      {
        client: fake.client,
        callModel: chat.callModel,
        nativeModels: new Map(),
      },
    );
    expect(fake.sent).toHaveLength(0);
    expect(response.source).toBe('estimated');
    expect(response.answers.damaged).toEqual({
      type: 'boolean',
      value: false,
      probability: 0.65,
    });
    const queue = response.answers.queue;
    assert(queue?.type === 'choice');
    expect(queue.value).toBe('billing');
    expect(queue.confidence).toBeCloseTo(0.75);
    expect(queue.probabilities.billing).toBeCloseTo(0.75);
    expect(queue.probabilities.shipping).toBeCloseTo(0.25);
    expect(response.answers.urgency).toEqual({
      type: 'score',
      value: 2,
      level: 'high',
      confidence: 1,
      probabilities: {
        low: 0,
        medium: 0,
        high: 1,
      },
    });
  });

  it('averages across samples and sums usage', async () => {
    const chat = scriptedChat([
      JSON.stringify({
        q: {
          yes: 0.2,
        },
      }),
      JSON.stringify({
        q: {
          yes: 0.8,
        },
      }),
    ]);
    const response = await callDecide(
      {
        model: 'openai/gpt-4o-mini',
        state: [],
        samples: 2,
        questions: {
          q: {
            type: 'boolean',
            instructions: 'Yes?',
          },
        },
      },
      {
        callModel: chat.callModel,
        nativeModels: new Map(),
      },
    );
    expect(chat.requests).toHaveLength(2);
    expect(response.answers.q).toEqual({
      type: 'boolean',
      value: true,
      probability: 0.5,
    });
    expect(response.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  it('averages the samples that parsed when one sample is malformed', async () => {
    const chat = scriptedChat([
      'not json',
      JSON.stringify({
        q: {
          yes: 0.9,
        },
      }),
      JSON.stringify({
        q: {
          yes: 0.7,
        },
      }),
    ]);
    const response = await callDecide(
      {
        model: 'openai/gpt-4o-mini',
        state: [],
        samples: 3,
        questions: {
          q: {
            type: 'boolean',
            instructions: 'Yes?',
          },
        },
      },
      {
        callModel: chat.callModel,
        nativeModels: new Map(),
      },
    );
    const q = response.answers.q;
    assert(q?.type === 'boolean');
    expect(q.probability).toBeCloseTo(0.8);
    expect(response.usage.inputTokens).toBe(30);
  });

  it('throws DecideOutputError when the estimate is not the requested shape', async () => {
    const chat = scriptedChat([
      'no json here',
    ]);
    try {
      await callDecide(
        {
          model: 'openai/gpt-4o-mini',
          state: [],
          questions: {
            q: {
              type: 'boolean',
              instructions: 'Yes?',
            },
          },
        },
        {
          callModel: chat.callModel,
          nativeModels: new Map(),
        },
      );
      expect.unreachable();
    } catch (e) {
      assert(e instanceof DecideOutputError);
      expect(e.raw).toBe('no json here');
      expect(e.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
      });
    }
  });
});
