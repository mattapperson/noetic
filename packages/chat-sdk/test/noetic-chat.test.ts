import { describe, expect, test } from 'bun:test';
import type { ExecuteInput, ExecuteOptions, HarnessResponse, SessionScope } from '@noetic/core';

import { buildThreadExecuteFn } from '../src/noetic-chat';

//#region Helpers

interface HarnessCall {
  readonly method: 'execute' | 'getAgentResponse';
  readonly threadId: string | undefined;
}

interface MockHarness {
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse>;
}

function makeResponse(text: string): HarnessResponse {
  return {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
    text,
  };
}

function makeMockHarness(): {
  harness: MockHarness;
  calls: HarnessCall[];
} {
  const calls: HarnessCall[] = [];
  const harness: MockHarness = {
    execute: async (_input, options) => {
      calls.push({
        method: 'execute',
        threadId: options?.threadId,
      });
    },
    getAgentResponse: async (scope) => {
      calls.push({
        method: 'getAgentResponse',
        threadId: scope?.threadId,
      });
      return makeResponse('ok');
    },
  };
  return {
    harness,
    calls,
  };
}

//#endregion

describe('buildThreadExecuteFn', () => {
  test('routes execute and getAgentResponse through the provided threadId', async () => {
    const { harness, calls } = makeMockHarness();

    const executeFn = buildThreadExecuteFn(harness, 'slack-channel-123');
    await executeFn('hello');

    expect(calls).toEqual([
      {
        method: 'execute',
        threadId: 'slack-channel-123',
      },
      {
        method: 'getAgentResponse',
        threadId: 'slack-channel-123',
      },
    ]);
  });

  test('isolates two concurrent threads on the same harness', async () => {
    const { harness, calls } = makeMockHarness();

    const threadA = buildThreadExecuteFn(harness, 'thread-A');
    const threadB = buildThreadExecuteFn(harness, 'thread-B');

    await threadA('question for A');
    await threadB('question for B');

    expect(calls).toEqual([
      {
        method: 'execute',
        threadId: 'thread-A',
      },
      {
        method: 'getAgentResponse',
        threadId: 'thread-A',
      },
      {
        method: 'execute',
        threadId: 'thread-B',
      },
      {
        method: 'getAgentResponse',
        threadId: 'thread-B',
      },
    ]);
  });

  test('defaults missing input to empty string', async () => {
    const { harness, calls } = makeMockHarness();

    const executeFn = buildThreadExecuteFn(harness, 'thread-X');
    await executeFn();

    expect(calls.length).toBe(2);
    expect(calls[0]?.method).toBe('execute');
  });
});
