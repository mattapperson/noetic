/**
 * A question held for a person (spec 08 § Held tool calls, `reason: 'question'`):
 * the answers it takes, and the form an answer must fit.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { HeldQuestion } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import type { HeldRecord } from '../../src/runtime/held-calls';
import { HeldCalls, heldArgsHash, toHeldCall } from '../../src/runtime/held-calls';
import { questionAnswerProblem } from '../../src/runtime/held-question';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

const FORM: HeldQuestion = {
  message: 'Which branch?',
  schema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
        enum: [
          'main',
          'next',
        ],
      },
      depth: {
        type: 'integer',
      },
      ratio: {
        type: 'number',
      },
      force: {
        type: 'boolean',
      },
    },
    required: [
      'branch',
    ],
  },
};

function question(callId = 'q1'): HeldRecord {
  const args = {
    message: FORM.message,
  };
  return {
    callId,
    name: 'agent:question',
    args,
    argsHash: heldArgsHash('agent:question', args),
    reason: 'question',
    question: FORM,
  };
}

async function openQuestion(): Promise<HeldCalls> {
  const holds = new HeldCalls(createInMemoryStorage(), () => 0);
  await holds.open('exec', question());
  return holds;
}

async function refusal(promise: Promise<void>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  assert(isNoeticError(error));
  expect(error.noeticError.kind).toBe('hold_refused');
  return error.message;
}

describe('questionAnswerProblem', () => {
  it('takes an answer that fits the form', () => {
    expect(
      questionAnswerProblem(FORM, {
        branch: 'main',
        depth: 2,
        ratio: 0.5,
        force: false,
      }),
    ).toBeUndefined();
  });

  it('takes any answer to a question with no form', () => {
    expect(
      questionAnswerProblem(
        {
          message: 'Open the page',
          url: 'https://example.test',
        },
        'anything',
      ),
    ).toBeUndefined();
    expect(questionAnswerProblem(undefined, 3)).toBeUndefined();
  });

  it('refuses a missing required field, a wrong type, a non-object', () => {
    expect(
      questionAnswerProblem(FORM, {
        depth: 1,
      }),
    ).toBe("'branch' is required");
    expect(
      questionAnswerProblem(FORM, {
        branch: 'main',
        depth: 1.5,
      }),
    ).toBe("'depth' must be an integer");
    expect(
      questionAnswerProblem(FORM, {
        branch: 'main',
        force: 'yes',
      }),
    ).toBe("'force' must be a boolean");
    expect(
      questionAnswerProblem(FORM, {
        branch: 'main',
        ratio: Number.NaN,
      }),
    ).toBe("'ratio' must be a number");
    expect(questionAnswerProblem(FORM, 'main')).toContain('must be an object');
  });

  it('counts only own fields: an inherited one never satisfies required', () => {
    expect(
      questionAnswerProblem(
        {
          message: 'q',
          schema: {
            type: 'object',
            properties: {},
            required: [
              'toString',
            ],
          },
        },
        {},
      ),
    ).toBe("'toString' is required");
  });

  it('checks the form’s constraints, at their boundaries', () => {
    const form: HeldQuestion = {
      message: 'q',
      schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 2,
            maxLength: 3,
            pattern: '^[a-z]+$',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 3,
          },
          tags: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: {
              enum: [
                'a',
                'b',
              ],
            },
          },
        },
        additionalProperties: false,
      },
    };
    expect(
      questionAnswerProblem(form, {
        name: 'ab',
        count: 1,
        tags: [
          'a',
        ],
      }),
    ).toBeUndefined();
    expect(
      questionAnswerProblem(form, {
        name: 'abc',
        count: 3,
        tags: [
          'a',
          'b',
        ],
      }),
    ).toBeUndefined();
    expect(
      questionAnswerProblem(form, {
        name: 'a',
      }),
    ).toContain('at least 2 characters');
    expect(
      questionAnswerProblem(form, {
        name: 'abcd',
      }),
    ).toContain('at most 3 characters');
    expect(
      questionAnswerProblem(form, {
        name: 'AB',
      }),
    ).toContain('must match');
    expect(
      questionAnswerProblem(form, {
        count: 0,
      }),
    ).toContain('at least 1');
    expect(
      questionAnswerProblem(form, {
        count: 4,
      }),
    ).toContain('at most 3');
    expect(
      questionAnswerProblem(form, {
        tags: [],
      }),
    ).toContain('at least 1 items');
    expect(
      questionAnswerProblem(form, {
        tags: [
          'a',
          'b',
          'a',
        ],
      }),
    ).toContain('at most 2 items');
    expect(
      questionAnswerProblem(form, {
        tags: [
          1,
        ],
      }),
    ).toContain('list of strings');
    expect(
      questionAnswerProblem(form, {
        extra: {
          nested: true,
        },
      }),
    ).toBe("'extra' is not a field of the form");
  });

  it('counts code points and refuses sparse lists', () => {
    const form: HeldQuestion = {
      message: 'q',
      schema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            oneOf: [
              {
                const: 'yes',
                title: 'Yes',
              },
            ],
          },
          emoji: {
            type: 'string',
            maxLength: 1,
          },
          tags: {
            type: 'array',
          },
        },
      },
    };
    expect(
      questionAnswerProblem(form, {
        emoji: '🍎',
      }),
    ).toBeUndefined();
    expect(
      questionAnswerProblem(form, {
        emoji: '🍎🍎',
      }),
    ).toContain('at most 1 characters');
    const sparse: string[] = [];
    sparse[1] = 'a';
    expect(
      questionAnswerProblem(form, {
        tags: sparse,
      }),
    ).toContain('list of strings');
  });

  it('takes an answer of the person’s own beside the listed choices', () => {
    const form: HeldQuestion = {
      message: 'q',
      schema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            oneOf: [
              {
                const: 'yes',
                title: 'Yes',
              },
            ],
          },
          tags: {
            type: 'array',
            items: {
              anyOf: [
                {
                  const: 'a',
                },
              ],
            },
          },
          plain: {
            type: 'array',
            items: {
              enum: [
                'a',
              ],
            },
          },
        },
      },
    };
    expect(
      questionAnswerProblem(form, {
        answer: 'Only on Fridays',
        tags: [
          'a',
          'something else',
        ],
        plain: [
          'c',
        ],
      }),
    ).toBeUndefined();
    expect(
      questionAnswerProblem(FORM, {
        branch: 'dev',
      }),
    ).toBeUndefined();
  });

  it('leaves a field the form does not describe alone', () => {
    expect(
      questionAnswerProblem(FORM, {
        branch: 'next',
        extra: [
          1,
        ],
      }),
    ).toBeUndefined();
  });
});

describe('a held question', () => {
  it('is shown with its question', async () => {
    const holds = await openQuestion();
    const record = await holds.load('exec', 'q1');
    assert(record);
    const shown = toHeldCall(record);
    expect(shown.reason).toBe('question');
    expect(shown.question).toEqual(FORM);
  });

  it('takes an answer that fits', async () => {
    const holds = await openQuestion();
    await holds.resolve('exec', {
      callId: 'q1',
      resolution: {
        output: {
          branch: 'main',
        },
      },
    });
    const record = await holds.load('exec', 'q1');
    expect(record?.resolution?.output).toEqual({
      branch: 'main',
    });
  });

  it('takes deny: the person declined', async () => {
    const holds = await openQuestion();
    await holds.resolve('exec', {
      callId: 'q1',
      resolution: {
        action: 'deny',
      },
    });
    const record = await holds.load('exec', 'q1');
    expect(record?.resolution?.action).toBe('deny');
  });

  it('refuses an answer that does not fit, and stays held', async () => {
    const holds = await openQuestion();
    const message = await refusal(
      holds.resolve('exec', {
        callId: 'q1',
        resolution: {
          output: {
            branch: 'main',
            depth: 'deep',
          },
        },
      }),
    );
    expect(message).toContain('does not fit the question');
    const record = await holds.load('exec', 'q1');
    expect(record?.resolution).toBeUndefined();
  });

  it('refuses allow and guide', async () => {
    const holds = await openQuestion();
    for (const action of [
      'allow',
      'guide',
    ] as const) {
      const message = await refusal(
        holds.resolve('exec', {
          callId: 'q1',
          resolution: {
            action,
          },
        }),
      );
      expect(message).toContain('a question takes an answer');
    }
  });
});

describe('a hold asked again by another host', () => {
  it('keeps its id and answer, and takes the asking host’s scope while unanswered', async () => {
    const holds = new HeldCalls(createInMemoryStorage(), () => 0);
    const first = {
      ...question('q2'),
      scope: {
        id: 'step/turn:aaaa/agent:c1',
        title: 'Explore',
      },
    };
    await holds.open('exec', first);
    const again = await holds.open('exec', {
      ...question('q2'),
      scope: {
        id: 'step/turn:bbbb/agent:c1',
        title: 'Explore',
      },
    });
    expect(again.scope?.id).toBe('step/turn:bbbb/agent:c1');
    expect((await holds.load('exec', 'q2'))?.scope?.id).toBe('step/turn:bbbb/agent:c1');

    await holds.resolve('exec', {
      callId: 'q2',
      resolution: {
        action: 'deny',
      },
    });
    const answered = await holds.open('exec', {
      ...question('q2'),
      scope: {
        id: 'step/turn:cccc/agent:c1',
      },
    });
    // Answered, it is left as it was: the answer is what matters now.
    expect(answered.scope?.id).toBe('step/turn:bbbb/agent:c1');
    expect(answered.resolution?.action).toBe('deny');
  });
});

describe('naming who asks, racing an answer', () => {
  /** Storage that runs `between` once, just before the first compare-and-set. */
  function racing(between: () => Promise<void>): ReturnType<typeof createInMemoryStorage> {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const swap = storage.swap?.bind(storage);
    let raced = false;
    return {
      ...storage,
      async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
        if (!raced) {
          raced = true;
          await between();
        }
        return (await swap?.(key, prev, next)) ?? false;
      },
    };
  }

  it('a rescope that loses to an answer never writes over it', async () => {
    let other: HeldCalls | undefined;
    const storage = racing(async () => {
      await other?.resolve('exec', {
        callId: 'q3',
        resolution: {
          action: 'deny',
        },
      });
    });
    const holds = new HeldCalls(storage, () => 0);
    other = new HeldCalls(storage, () => 0);
    await holds.open('exec', question('q3'));
    const after = await holds.rescope('exec', 'q3', {
      id: 'new-scope',
    });
    expect(after?.resolution?.action).toBe('deny');
    expect((await holds.load('exec', 'q3'))?.resolution?.action).toBe('deny');
  });

  it('an answer that loses to a rescope is answered again, not refused', async () => {
    let other: HeldCalls | undefined;
    const storage = racing(async () => {
      await other?.rescope('exec', 'q4', {
        id: 'another-host',
      });
    });
    const holds = new HeldCalls(storage, () => 0);
    other = new HeldCalls(storage, () => 0);
    await holds.open('exec', question('q4'));
    await holds.resolve('exec', {
      callId: 'q4',
      resolution: {
        action: 'deny',
      },
    });
    const record = await holds.load('exec', 'q4');
    expect(record?.resolution?.action).toBe('deny');
    expect(record?.scope?.id).toBe('another-host');
  });
});

describe('naming who asks on storage without compare-and-set', () => {
  it('a rescope and an answer in one process take turns: the answer survives', async () => {
    const storage = createInMemoryStorage();
    const set = storage.set.bind(storage);
    let release: () => void = () => undefined;
    let paused = false;
    const holds = new HeldCalls(
      {
        ...storage,
        async set<T>(key: string, value: T): Promise<void> {
          // Hold the rescope's write until the answer has been submitted.
          if (!paused && JSON.stringify(value).includes('late-scope')) {
            paused = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          await set(key, value);
        },
      },
      () => 0,
    );
    await holds.open('exec', question('q5'));
    const renaming = holds.rescope('exec', 'q5', {
      id: 'late-scope',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const answering = holds.resolve('exec', {
      callId: 'q5',
      resolution: {
        action: 'deny',
      },
    });
    release();
    await Promise.all([
      renaming,
      answering,
    ]);
    const record = await holds.load('exec', 'q5');
    expect(record?.resolution?.action).toBe('deny');
  });

  it('an answer retried after a renaming never lands on a question that replaced it meanwhile', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const swap = storage.swap?.bind(storage);
    let swaps = 0;
    const holds = new HeldCalls(
      {
        ...storage,
        async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
          swaps += 1;
          // First another host renames the hold; then, as the answer is given
          // again, another replaces the question.
          await storage.set(
            key,
            swaps === 1
              ? {
                  ...question('q7'),
                  scope: {
                    id: 'other-host',
                  },
                }
              : {
                  ...question('q7'),
                  args: {
                    message: 'something else',
                  },
                },
          );
          return (await swap?.(key, prev, next)) ?? false;
        },
      },
      () => 0,
    );
    await holds.open('exec', question('q7'));
    const error = await holds
      .resolve('exec', {
        callId: 'q7',
        resolution: {
          action: 'deny',
        },
      })
      .catch((e: unknown) => e);
    assert(isNoeticError(error));
    expect(error.message).toContain('replaced');
    expect(swaps).toBe(2);
    const record = await holds.load('exec', 'q7');
    expect(record?.resolution).toBeUndefined();
  });

  it('a renaming that loses to a replacement leaves the new question alone', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const swap = storage.swap?.bind(storage);
    let raced = false;
    const holds = new HeldCalls(
      {
        ...storage,
        async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
          if (!raced) {
            raced = true;
            // Another process moves the call on to a question of another kind.
            await storage.set(key, {
              ...question('q9'),
              reason: 'result',
            });
          }
          return (await swap?.(key, prev, next)) ?? false;
        },
      },
      () => 0,
    );
    await holds.open('exec', question('q9'));
    const now = await holds.rescope('exec', 'q9', {
      id: 'late-scope',
    });
    expect(now?.reason).toBe('result');
    expect(now?.scope).toBeUndefined();
    const stored = await holds.load('exec', 'q9');
    expect(stored?.scope).toBeUndefined();
  });

  it('dropping a hold while its answer is being written settles it as answered', async () => {
    const storage = createInMemoryStorage();
    const set = storage.set.bind(storage);
    let release: () => void = () => undefined;
    let paused = false;
    const holds = new HeldCalls(
      {
        ...storage,
        async set<T>(key: string, value: T): Promise<void> {
          // Stall the answer's write until the hold is being dropped.
          if (!paused && JSON.stringify(value).includes('"resolution"')) {
            paused = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          await set(key, value);
        },
      },
      () => 0,
    );
    const record = question('q10');
    await holds.open('exec', record);
    const settled: string[] = [];
    holds.watch('exec', toHeldCall(record), (event) => {
      settled.push(event.by);
    });
    const answering = holds.resolve('exec', {
      callId: 'q10',
      resolution: {
        action: 'deny',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = holds.close('exec', 'q10');
    release();
    await Promise.all([
      answering,
      closing,
    ]);
    expect(settled).toEqual([
      'answer',
    ]);
    expect(await holds.load('exec', 'q10')).toBeUndefined();
  });

  it('a renaming still running when the hold is dropped never writes it back', async () => {
    const storage = createInMemoryStorage();
    const set = storage.set.bind(storage);
    let release: () => void = () => undefined;
    let paused = false;
    const holds = new HeldCalls(
      {
        ...storage,
        async set<T>(key: string, value: T): Promise<void> {
          if (!paused && JSON.stringify(value).includes('late-scope')) {
            paused = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          await set(key, value);
        },
      },
      () => 0,
    );
    await holds.open('exec', question('q8'));
    const renaming = holds.rescope('exec', 'q8', {
      id: 'late-scope',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = holds.close('exec', 'q8');
    release();
    await Promise.all([
      renaming,
      closing,
    ]);
    expect(await holds.load('exec', 'q8')).toBeUndefined();
  });

  it('an answer racing a replacement with other arguments is refused, never applied to it', async () => {
    const storage = createInMemoryStorage({
      swap: true,
    });
    const swap = storage.swap?.bind(storage);
    let raced = false;
    const holds = new HeldCalls(
      {
        ...storage,
        async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
          if (!raced) {
            raced = true;
            // Another host replaces the hold with one for other arguments.
            await storage.set(key, {
              ...question('q6'),
              args: {
                message: 'something else',
              },
            });
          }
          return (await swap?.(key, prev, next)) ?? false;
        },
      },
      () => 0,
    );
    await holds.open('exec', question('q6'));
    const error = await holds
      .resolve('exec', {
        callId: 'q6',
        resolution: {
          action: 'deny',
        },
      })
      .catch((e: unknown) => e);
    assert(isNoeticError(error));
    expect(error.message).toContain('replaced');
  });
});
