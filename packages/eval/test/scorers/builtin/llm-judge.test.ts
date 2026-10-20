import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isNoeticConfigError } from '@noetic-tools/core';
import { z } from 'zod';

import { resolveJudgeProvider, runJudge } from '../../../src/scorers/builtin/llm-judge';

/**
 * The judge harness used to receive `judge.callModel` alone, so an environment
 * carrying only `OPENROUTER_API_KEY` fell through to the harness's `noetic`
 * default and failed every judge suite with NO_LLM_PROVIDER. It now falls back
 * to the shared env resolver.
 *
 * These cases are network-free: provider selection is asserted on the resolver
 * itself, and the one end-to-end case fails before any request is made. Ambient
 * keys are saved, cleared for the duration of each test, and restored — a real
 * key is never read into an assertion, and only synthetic values are set.
 */
const ENV_KEYS = [
  'NOETIC_API_KEY',
  'OPENROUTER_API_KEY',
  'NOETIC_BASE_URL',
] as const;

const FAKE_NOETIC_KEY = 'test-noetic-key';
const FAKE_OPENROUTER_KEY = 'test-openrouter-key';

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
});

describe('resolveJudgeProvider', () => {
  test('returns undefined with no config and no keys, leaving the harness to report the misconfiguration', () => {
    expect(resolveJudgeProvider()).toBeUndefined();
  });

  test('falls back to OpenRouter when only an OpenRouter key is set', () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    expect(resolveJudgeProvider()).toEqual({
      provider: 'openrouter',
    });
  });

  test('returns undefined for a Noetic key because the harness already defaults to noetic', () => {
    process.env.NOETIC_API_KEY = FAKE_NOETIC_KEY;

    expect(resolveJudgeProvider()).toBeUndefined();
  });

  test('an explicit judge.callModel wins over the environment fallback', () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    const resolved = resolveJudgeProvider({
      callModel: {
        provider: 'noetic',
      },
    });

    expect(resolved).toEqual({
      provider: 'noetic',
    });
  });

  test('never copies an API key out of the environment into the provider config', () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    expect(JSON.stringify(resolveJudgeProvider())).not.toContain(FAKE_OPENROUTER_KEY);
  });
});

describe('runJudge without any provider', () => {
  test('surfaces NO_LLM_PROVIDER rather than a generic failure', async () => {
    let caught: unknown;
    try {
      await runJudge({
        id: 'test-judge',
        instructions: 'Score the response.',
        input: 'some output',
        outputSchema: z.object({
          score: z.number(),
        }),
      });
    } catch (e) {
      caught = e;
    }

    expect(isNoeticConfigError(caught)).toBe(true);
    if (!isNoeticConfigError(caught)) {
      throw new Error('expected a NoeticConfigError');
    }
    expect(caught.code).toBe('NO_LLM_PROVIDER');
  });
});
