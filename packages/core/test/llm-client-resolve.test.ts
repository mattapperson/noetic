/**
 * resolveLlmClient — provider/credential/base-URL resolution. The harness now
 * defaults to the Noetic platform; OpenRouter is opt-in.
 */

import { describe, expect, test } from 'bun:test';
import { resolveLlmClient } from '../src/harness/agent-harness';

const NOETIC_BASE = 'https://platform.noetic.tools/v1';

describe('resolveLlmClient', () => {
  test('defaults to the Noetic platform when provider is omitted', () => {
    const resolved = resolveLlmClient(undefined, {
      noeticApiKey: 'noetic_live_x',
    });
    expect(resolved).toEqual({
      apiKey: 'noetic_live_x',
      serverURL: NOETIC_BASE,
      cache: false,
    });
  });

  test('noetic provider uses NOETIC_API_KEY and the platform base URL', () => {
    const resolved = resolveLlmClient(
      {
        provider: 'noetic',
      },
      {
        noeticApiKey: 'k',
        openrouterApiKey: 'or',
      },
    );
    expect(resolved?.apiKey).toBe('k');
    expect(resolved?.serverURL).toBe(NOETIC_BASE);
  });

  test('NOETIC_BASE_URL overrides the default platform base URL', () => {
    const resolved = resolveLlmClient(undefined, {
      noeticApiKey: 'k',
      noeticBaseUrl: 'https://staging.example/v1',
    });
    expect(resolved?.serverURL).toBe('https://staging.example/v1');
  });

  test('config.baseUrl wins over env and the default', () => {
    const resolved = resolveLlmClient(
      {
        baseUrl: 'https://self.host/v1',
      },
      {
        noeticApiKey: 'k',
        noeticBaseUrl: 'https://env.example/v1',
      },
    );
    expect(resolved?.serverURL).toBe('https://self.host/v1');
  });

  test('openrouter provider uses OPENROUTER_API_KEY and the SDK default base URL', () => {
    const resolved = resolveLlmClient(
      {
        provider: 'openrouter',
      },
      {
        openrouterApiKey: 'or',
        noeticApiKey: 'k',
      },
    );
    // serverURL undefined → the SDK falls back to its default OpenRouter endpoint.
    expect(resolved).toEqual({
      apiKey: 'or',
      serverURL: undefined,
      cache: false,
    });
  });

  test('explicit config.apiKey wins over the environment', () => {
    const resolved = resolveLlmClient(
      {
        apiKey: 'explicit',
      },
      {
        noeticApiKey: 'env',
      },
    );
    expect(resolved?.apiKey).toBe('explicit');
  });

  test('returns undefined when no API key is available for the chosen provider', () => {
    expect(resolveLlmClient(undefined, {})).toBeUndefined();
    // openrouter selected but only a Noetic key is present.
    expect(
      resolveLlmClient(
        {
          provider: 'openrouter',
        },
        {
          noeticApiKey: 'k',
        },
      ),
    ).toBeUndefined();
  });

  test('threads the cache flag through', () => {
    expect(
      resolveLlmClient(
        {
          cache: true,
        },
        {
          noeticApiKey: 'k',
        },
      )?.cache,
    ).toBe(true);
  });
});
