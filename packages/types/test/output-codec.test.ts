import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { OutputCodec, OutputCodecSession, ToolUiDeclaration, UiFragment } from '../src';
import { isOutputCodec } from '../src';

function makeCodec(): OutputCodec<string> {
  const session: OutputCodecSession<string> = {
    push(_delta, _emit) {},
    finish(fullText) {
      return fullText.toUpperCase();
    },
  };
  return {
    kind: 'codec',
    instructions: 'Respond in the test dialect.',
    start: () => session,
  };
}

describe('isOutputCodec', () => {
  test('accepts a well-formed codec', () => {
    expect(isOutputCodec(makeCodec())).toBe(true);
  });

  test('rejects a Zod schema', () => {
    expect(
      isOutputCodec(
        z.object({
          a: z.string(),
        }),
      ),
    ).toBe(false);
  });

  test('rejects null, primitives, and near-misses', () => {
    expect(isOutputCodec(null)).toBe(false);
    expect(isOutputCodec(undefined)).toBe(false);
    expect(isOutputCodec('codec')).toBe(false);
    expect(
      isOutputCodec({
        kind: 'codec',
      }),
    ).toBe(false); // missing start()
    expect(
      isOutputCodec({
        kind: 'other',
        start: () => ({}),
      }),
    ).toBe(false);
  });

  test('narrowed codec round-trips a session', () => {
    const value: OutputCodec<string> | null = makeCodec();
    expect(isOutputCodec<string>(value)).toBe(true);
    if (!isOutputCodec<string>(value)) {
      throw new Error('unreachable');
    }
    const session = value.start();
    session.push('hel', () => {});
    session.push('lo', () => {});
    expect(session.finish('hello')).toBe('HELLO');
  });
});

describe('ToolUiDeclaration shape', () => {
  test('a concretely-typed declaration assigns to the erased form', () => {
    const Input = z.object({
      carrier: z.string(),
    });
    const Output = z.object({
      price: z.number(),
    });
    const concrete: ToolUiDeclaration<
      typeof Input,
      typeof Output,
      {
        pct: number;
      }
    > = {
      call: (args) => ({
        dialect: 'openui-lang/0.5',
        source: `root = Text("${args.carrier ?? '…'}")`,
      }),
      progress: (events) => ({
        dialect: 'openui-lang/0.5',
        source: `root = Progress(${events.at(-1)?.pct ?? 0})`,
      }),
      result: (out) => ({
        dialect: 'openui-lang/0.5',
        source: `root = Text("${out.price}")`,
      }),
      error: () => null,
    };
    const erased: ToolUiDeclaration = concrete;
    const fragment: UiFragment | null | undefined = erased.call?.({
      carrier: 'ups',
    });
    expect(fragment?.dialect).toBe('openui-lang/0.5');
    expect(fragment?.source).toContain('ups');
  });
});
