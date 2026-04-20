import { describe, expect, test } from 'bun:test';

import { createCallModel } from '../src/ai/plugin-call-model.js';

describe('createCallModel', () => {
  test('sends bearer auth + body, parses OpenAI-compatible response', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedAuth: string | undefined;
    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedBody = typeof init?.body === 'string' ? init.body : undefined;
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get('authorization') ?? undefined;
      return new Response(
        JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          choices: [
            {
              message: {
                content: 'hello world',
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        {
          status: 200,
        },
      );
    };

    const callModel = createCallModel({
      apiKey: 'sk-test',
      defaultModel: 'anthropic/claude-sonnet-4',
      fetchFn,
    });
    const result = await callModel({
      messages: [
        {
          role: 'system',
          content: 'be brief',
        },
        {
          role: 'user',
          content: 'say hi',
        },
      ],
    });

    expect(result.text).toBe('hello world');
    expect(result.modelId).toBe('anthropic/claude-sonnet-4');
    expect(result.usage?.totalTokens).toBe(15);
    expect(capturedAuth).toBe('Bearer sk-test');
    expect(capturedUrl).toContain('openrouter.ai');
    expect(capturedBody).toContain('say hi');
  });

  test('throws on non-ok response', async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response('server oops', {
        status: 500,
        statusText: 'Internal Server Error',
      });
    const callModel = createCallModel({
      apiKey: 'k',
      defaultModel: 'm',
      fetchFn,
    });
    await expect(
      callModel({
        messages: [
          {
            role: 'user',
            content: 'x',
          },
        ],
      }),
    ).rejects.toThrow(/callModel failed/);
  });

  test('throws on malformed response', async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          junk: 'yes',
        }),
        {
          status: 200,
        },
      );
    const callModel = createCallModel({
      apiKey: 'k',
      defaultModel: 'm',
      fetchFn,
    });
    await expect(
      callModel({
        messages: [
          {
            role: 'user',
            content: 'x',
          },
        ],
      }),
    ).rejects.toThrow(/malformed response/);
  });
});
