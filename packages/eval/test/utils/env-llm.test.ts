import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resolveEnvLlm, resolveEnvLlmCredentials } from '../../src/utils/env-llm';

/**
 * Every test drives the resolvers through synthetic key values only. Any real
 * key present in the ambient environment is saved, cleared for the duration of
 * the test, and restored afterwards — it is never read into an assertion.
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

describe('resolveEnvLlm', () => {
  test('returns undefined with no keys set so the harness resolves its own default', () => {
    expect(resolveEnvLlm()).toBeUndefined();
  });

  test('returns undefined for a Noetic key because the harness already defaults to noetic', () => {
    process.env.NOETIC_API_KEY = FAKE_NOETIC_KEY;
    expect(resolveEnvLlm()).toBeUndefined();
  });

  test('selects the openrouter provider when only an OpenRouter key is set', () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;
    expect(resolveEnvLlm()).toEqual({
      provider: 'openrouter',
    });
  });

  test('never copies the API key into the returned provider config', () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    const config = resolveEnvLlm();

    expect(config).toBeDefined();
    expect(JSON.stringify(config)).not.toContain(FAKE_OPENROUTER_KEY);
  });

  test('prefers the Noetic default over OpenRouter when both keys are set', () => {
    process.env.NOETIC_API_KEY = FAKE_NOETIC_KEY;
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;
    expect(resolveEnvLlm()).toBeUndefined();
  });
});

describe('resolveEnvLlmCredentials', () => {
  test('returns undefined with no keys set so callers take the offline path', () => {
    expect(resolveEnvLlmCredentials()).toBeUndefined();
  });

  test('resolves the Noetic platform endpoint from a Noetic key', () => {
    process.env.NOETIC_API_KEY = FAKE_NOETIC_KEY;

    expect(resolveEnvLlmCredentials()).toEqual({
      provider: 'noetic',
      apiKey: FAKE_NOETIC_KEY,
      apiURL: 'https://platform.noetic.tools/v1',
    });
  });

  test('honors NOETIC_BASE_URL for self-hosted or staging platforms', () => {
    process.env.NOETIC_API_KEY = FAKE_NOETIC_KEY;
    process.env.NOETIC_BASE_URL = 'https://staging.example.test/v1';

    const credentials = resolveEnvLlmCredentials();

    expect(credentials?.apiURL).toBe('https://staging.example.test/v1');
  });

  test('resolves the OpenRouter endpoint when only an OpenRouter key is set', () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    expect(resolveEnvLlmCredentials()).toEqual({
      provider: 'openrouter',
      apiKey: FAKE_OPENROUTER_KEY,
      apiURL: 'https://openrouter.ai/api/v1',
    });
  });

  test('prefers Noetic over OpenRouter when both keys are set', () => {
    process.env.NOETIC_API_KEY = FAKE_NOETIC_KEY;
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;

    const credentials = resolveEnvLlmCredentials();

    expect(credentials?.provider).toBe('noetic');
    expect(credentials?.apiKey).toBe(FAKE_NOETIC_KEY);
  });

  test('ignores an empty-string key rather than resolving an unusable endpoint', () => {
    process.env.NOETIC_API_KEY = '';
    process.env.OPENROUTER_API_KEY = '';

    expect(resolveEnvLlmCredentials()).toBeUndefined();
  });
});
