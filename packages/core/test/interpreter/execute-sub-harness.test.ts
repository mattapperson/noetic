import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  Item,
  StepSubHarness,
  SubHarness,
  SubHarnessKind,
  SubHarnessSession,
  SubHarnessStartOptions,
  SubHarnessStreamPart,
  SubHarnessTurnResult,
  TokenUsage,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { makeMessage } from '../_helpers';

//#region Fake harness adapter

interface FakeHarnessOpts {
  harnessId?: SubHarnessKind;
  text?: string;
  items?: Item[];
  usage?: TokenUsage | null;
  cost?: number;
  onStart?: (opts: SubHarnessStartOptions) => void;
  onStop?: () => void;
  throwOnTurn?: Error;
}

function fakeHarness(opts: FakeHarnessOpts = {}): SubHarness {
  const text = opts.text ?? 'done';
  const harnessId = opts.harnessId ?? 'claude-code';
  return {
    specificationVersion: 'harness-v1',
    harnessId,
    async doStart(start): Promise<SubHarnessSession> {
      opts.onStart?.(start);
      return {
        sessionId: 'session-1',
        isResume: false,
        async doPromptTurn(turn): Promise<SubHarnessTurnResult> {
          if (opts.throwOnTurn) {
            throw opts.throwOnTurn;
          }
          const part: SubHarnessStreamPart = {
            type: 'text-delta',
            delta: text,
          };
          turn.emit(part);
          return {
            items: opts.items ?? [
              makeMessage('assistant', text),
            ],
            text,
            usage:
              opts.usage === null
                ? undefined
                : (opts.usage ?? {
                    input: 10,
                    output: 5,
                    total: 15,
                  }),
            cost: opts.cost,
          };
        },
        async doStop() {
          opts.onStop?.();
          return {
            harnessId,
            sessionId: 'session-1',
            state: null,
          };
        },
      };
    },
  };
}

function harnessCtx() {
  const harness = new AgentHarness({
    name: 'test',
    params: {},
  });
  return {
    harness,
    ctx: harness.createContext(),
  };
}

//#endregion

describe('executeSubHarness', () => {
  it('runs a one-shot turn: appends items, tracks usage, sets lastStepMeta, returns text', async () => {
    const { ctx } = harnessCtx();
    const harnessStep = step.claudeCode({
      id: 'review',
      harness: fakeHarness({
        text: 'reviewed',
        cost: 0.002,
      }),
      prompt: 'review the diff',
    });

    const result = await execute(harnessStep, undefined, ctx);

    expect(result).toBe('reviewed');
    const texts = ctx.itemLog.items
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content.map((c) => ('text' in c ? c.text : '')));
    expect(texts).toContain('review the diff');
    expect(texts).toContain('reviewed');
    expect(ctx.tokens.total).toBe(15);
    expect(ctx.cost).toBeCloseTo(0.002, 6);
    assert(ctx.lastStepMeta);
    assert(ctx.lastStepMeta.usage);
    expect(ctx.lastStepMeta.usage.inputTokens).toBe(10);
  });

  it('parses structured output through the step schema', async () => {
    const { ctx } = harnessCtx();
    const harnessStep = step.codex({
      id: 'extract',
      harness: fakeHarness({
        harnessId: 'codex',
        text: '{"ok":true,"count":3}',
      }),
      prompt: 'extract',
      output: z.object({
        ok: z.boolean(),
        count: z.number(),
      }),
    });

    const result = await execute(harnessStep, undefined, ctx);
    expect(result).toEqual({
      ok: true,
      count: 3,
    });
  });

  it('uses string input as the prompt when prompt resolves empty', async () => {
    const { ctx } = harnessCtx();
    let seenInstructions: string | undefined;
    const harnessStep = step.claudeCode({
      id: 'from-input',
      harness: fakeHarness({
        onStart: (o) => {
          seenInstructions = o.instructions;
        },
      }),
      prompt: '',
      instructions: 'be terse',
    });

    await execute(harnessStep, 'prompt-from-input', ctx);
    const texts = ctx.itemLog.items
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content.map((c) => ('text' in c ? c.text : '')));
    expect(texts).toContain('prompt-from-input');
    expect(seenInstructions).toBe('be terse');
  });

  it('reuses a session across steps when session.reuse is set', async () => {
    const { ctx } = harnessCtx();
    let starts = 0;
    const adapter = fakeHarness({
      onStart: () => {
        starts++;
      },
    });
    const first = step.claudeCode({
      id: 'turn-1',
      harness: adapter,
      prompt: 'first',
      session: {
        reuse: 'shared',
      },
    });
    const second = step.claudeCode({
      id: 'turn-2',
      harness: adapter,
      prompt: 'second',
      session: {
        reuse: 'shared',
      },
    });

    await execute(first, undefined, ctx);
    await execute(second, undefined, ctx);
    expect(starts).toBe(1);
  });

  it('stops a fresh session by default and on explicit onComplete', async () => {
    const { ctx } = harnessCtx();
    let stops = 0;
    const harnessStep = step.claudeCode({
      id: 'stops',
      harness: fakeHarness({
        onStop: () => {
          stops++;
        },
      }),
      prompt: 'go',
    });
    await execute(harnessStep, undefined, ctx);
    expect(stops).toBe(1);
  });

  it('omits usage tracking when the turn reports none', async () => {
    const { ctx } = harnessCtx();
    const harnessStep = step.opencode({
      id: 'no-usage',
      harness: fakeHarness({
        harnessId: 'opencode',
        usage: null,
      }),
      prompt: 'go',
    });
    await execute(harnessStep, undefined, ctx);
    expect(ctx.tokens.total).toBe(0);
    assert(ctx.lastStepMeta);
    expect(ctx.lastStepMeta.usage).toBeUndefined();
  });

  //#region error kinds

  it('throws MISSING_HARNESS when a lazy adapter resolves undefined', async () => {
    const { ctx } = harnessCtx();
    const badStep: StepSubHarness = {
      kind: 'claude-code',
      id: 'no-adapter',
      harness: () => frameworkCast<SubHarness>(undefined),
      prompt: 'go',
    };
    try {
      await execute(badStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_SUB_HARNESS');
    }
  });

  it('throws HARNESS_KIND_MISMATCH when the builder gets a mismatched adapter', () => {
    try {
      step.claudeCode({
        id: 'mismatch',
        harness: fakeHarness({
          harnessId: 'codex',
        }),
        prompt: 'go',
      });
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('SUB_HARNESS_KIND_MISMATCH');
    }
  });

  it('throws MISSING_PROMPT when prompt and input are both empty', async () => {
    const { ctx } = harnessCtx();
    const harnessStep = step.pi({
      id: 'empty',
      harness: fakeHarness({
        harnessId: 'pi',
      }),
      prompt: '',
    });
    try {
      await execute(harnessStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('MISSING_PROMPT');
    }
  });

  it('wraps turn failures as step_failed', async () => {
    const { ctx } = harnessCtx();
    const harnessStep = step.claudeCode({
      id: 'boom',
      harness: fakeHarness({
        throwOnTurn: new Error('agent crashed'),
      }),
      prompt: 'go',
    });
    try {
      await execute(harnessStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
    }
  });

  it('throws llm_parse_error when structured output is unparseable', async () => {
    const { ctx } = harnessCtx();
    const harnessStep = step.claudeCode({
      id: 'bad-json',
      harness: fakeHarness({
        text: 'not json',
      }),
      prompt: 'go',
      output: z.object({
        ok: z.boolean(),
      }),
    });
    try {
      await execute(harnessStep, undefined, ctx);
      throw new Error('expected throw');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('llm_parse_error');
    }
  });

  //#endregion

  //#region conversational history

  it('passes prior conversation history so the agent has full context', async () => {
    const { ctx } = harnessCtx();
    // Earlier turns of the conversation (e.g. from LLM steps).
    ctx.itemLog.append(makeMessage('user', 'My name is Ada and I work in src/agents.'));
    ctx.itemLog.append(makeMessage('assistant', 'Got it, Ada.'));

    let seenHistory: ReadonlyArray<Item> = [];
    // An adapter that answers from the history — proving it received full context.
    const contextAware: SubHarness = {
      specificationVersion: 'harness-v1',
      harnessId: 'claude-code',
      async doStart(start: SubHarnessStartOptions): Promise<SubHarnessSession> {
        seenHistory = start.history ?? [];
        const transcript = seenHistory
          .flatMap((i) => (i.type === 'message' ? i.content : []))
          .map((c) => ('text' in c ? c.text : ''))
          .join(' ');
        return {
          sessionId: 's',
          isResume: false,
          async doPromptTurn(turn): Promise<SubHarnessTurnResult> {
            const text = transcript.includes('Ada')
              ? 'Your name is Ada, working in src/agents.'
              : "I don't have any prior context.";
            turn.emit({
              type: 'text-delta',
              delta: text,
            });
            return {
              items: [
                makeMessage('assistant', text),
              ],
              text,
            };
          },
          async doStop() {
            return {
              harnessId: 'claude-code',
              sessionId: 's',
              state: null,
            };
          },
        };
      },
    };
    const harnessStep = step.claudeCode({
      id: 'ctx',
      harness: contextAware,
      prompt: 'What is my name and where do I work?',
    });

    const out = await execute(harnessStep, undefined, ctx);

    // The prior conversation was passed in as history...
    expect(seenHistory).toHaveLength(2);
    // ...and the agent shows evidence of full context (no confusion).
    expect(out).toContain('Ada');
    expect(out).toContain('src/agents');
    expect(out).not.toContain("don't have any prior context");
  });

  it('history excludes the current prompt and accumulates across consecutive steps', async () => {
    const { ctx } = harnessCtx();
    const lengths: number[] = [];
    const recorder: SubHarness = {
      specificationVersion: 'harness-v1',
      harnessId: 'codex',
      async doStart(start: SubHarnessStartOptions): Promise<SubHarnessSession> {
        lengths.push((start.history ?? []).length);
        return {
          sessionId: 's',
          isResume: false,
          async doPromptTurn(): Promise<SubHarnessTurnResult> {
            return {
              items: [
                makeMessage('assistant', 'ack'),
              ],
              text: 'ack',
            };
          },
          async doStop() {
            return {
              harnessId: 'codex',
              sessionId: 's',
              state: null,
            };
          },
        };
      },
    };

    await execute(
      step.codex({
        id: 'a',
        harness: recorder,
        prompt: 'first',
      }),
      undefined,
      ctx,
    );
    await execute(
      step.codex({
        id: 'b',
        harness: recorder,
        prompt: 'second',
      }),
      undefined,
      ctx,
    );

    // First step: empty history (start of run, current prompt not yet counted).
    expect(lengths[0]).toBe(0);
    // Second step sees the first step's user prompt + assistant reply (2 items).
    expect(lengths[1]).toBe(2);
  });

  //#endregion
});
