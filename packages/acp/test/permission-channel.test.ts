/**
 * Routing a permission request to a human over external channels.
 *
 * The handler is exercised against a stub context that implements just the
 * channel surface it uses, so these tests pin the request/decision protocol
 * itself rather than the channel store's internals.
 */

import { describe, expect, test } from 'bun:test';
import type {
  AcpPermissionRequestInfo,
  AcpRequestPermissionRequest,
  Channel,
  Context,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { AcpPermissionPrompt, AcpPermissionReply } from '../src/permission-channel';
import {
  acpPermissionDecisions,
  acpPermissionRequests,
  askUserForPermission,
} from '../src/permission-channel';

//#region Stub context

interface ChannelStub {
  ctx: Context;
  /** Prompts the handler published, in order. */
  sent: AcpPermissionPrompt[];
  /** Deliver one decision to whoever is waiting. */
  reply(value: AcpPermissionReply): void;
}

/**
 * A context whose `send`/`recv` back onto in-memory queues. `recv` parks until
 * a value arrives or its timeout elapses, matching the real contract closely
 * enough to pin the handler's correlation and deadline behaviour.
 */
function channelStub(): ChannelStub {
  const sent: AcpPermissionPrompt[] = [];
  const waiters: Array<(value: AcpPermissionReply) => void> = [];
  const pending: AcpPermissionReply[] = [];

  const ctx = frameworkCast<Context>({
    threadId: 'thread-1',
    async send(channel: Channel<unknown>, value: unknown) {
      if (channel.name === acpPermissionRequests.name) {
        sent.push(frameworkCast<AcpPermissionPrompt>(value));
      }
    },
    recv(
      _channel: Channel<unknown>,
      opts?: {
        timeout?: number;
      },
    ) {
      const queued = pending.shift();
      if (queued) {
        return Promise.resolve(queued);
      }
      return new Promise((resolve, reject) => {
        const timer =
          opts?.timeout === undefined
            ? undefined
            : setTimeout(() => reject(new Error('channel_timeout')), opts.timeout);
        waiters.push((value) => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve(value);
        });
      });
    },
  });

  return {
    ctx,
    sent,
    reply(value) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
        return;
      }
      pending.push(value);
    },
  };
}

const INFO: AcpPermissionRequestInfo = {
  agentId: 'claude-code',
  stepId: 'review',
};

function request(
  overrides: Partial<AcpRequestPermissionRequest> = {},
): AcpRequestPermissionRequest {
  return {
    sessionId: 'session-1',
    options: [
      {
        optionId: 'yes',
        name: 'Allow once',
        kind: 'allow_once',
      },
      {
        optionId: 'no',
        name: 'Reject',
        kind: 'reject_once',
      },
    ],
    toolCall: {
      toolCallId: 'call-1',
      title: 'Run rm -rf /tmp/scratch',
      kind: 'execute',
      rawInput: {
        command: 'rm -rf /tmp/scratch',
      },
    },
    ...overrides,
  };
}

//#endregion

describe('askUserForPermission', () => {
  test('publishes a prompt carrying everything a reviewer needs', async () => {
    const stub = channelStub();
    const handler = askUserForPermission();

    const pending = handler(request(), stub.ctx, INFO);
    // Let the send settle before answering.
    await Promise.resolve();

    expect(stub.sent).toHaveLength(1);
    const prompt = stub.sent[0];
    expect(prompt).toBeDefined();
    if (!prompt) {
      throw new Error('no prompt published');
    }
    expect(prompt.agentId).toBe('claude-code');
    expect(prompt.stepId).toBe('review');
    expect(prompt.sessionId).toBe('session-1');
    expect(prompt.threadId).toBe('thread-1');
    expect(prompt.title).toBe('Run rm -rf /tmp/scratch');
    expect(prompt.kind).toBe('execute');
    expect(prompt.rawInput).toEqual({
      command: 'rm -rf /tmp/scratch',
    });
    // A UI must offer the agent's own options, not invent its own.
    expect(prompt.options.map((o) => o.optionId)).toEqual([
      'yes',
      'no',
    ]);

    stub.reply({
      requestId: prompt.requestId,
      decision: 'allow',
    });
    expect((await pending).decision).toBe('allow');
  });

  test('carries the answer back, including a pinned option and reason', async () => {
    const stub = channelStub();
    const pending = askUserForPermission()(request(), stub.ctx, INFO);
    await Promise.resolve();
    const prompt = stub.sent[0];
    if (!prompt) {
      throw new Error('no prompt published');
    }

    stub.reply({
      requestId: prompt.requestId,
      decision: 'deny',
      optionId: 'no',
      reason: 'too destructive',
    });

    expect(await pending).toEqual({
      decision: 'deny',
      optionId: 'no',
      reason: 'too destructive',
    });
  });

  test('ignores decisions belonging to another request', async () => {
    const stub = channelStub();
    const pending = askUserForPermission()(request(), stub.ctx, INFO);
    await Promise.resolve();
    const prompt = stub.sent[0];
    if (!prompt) {
      throw new Error('no prompt published');
    }

    // Decisions are broadcast, so a waiter sees answers meant for others.
    stub.reply({
      requestId: 'someone-else',
      decision: 'allow',
    });
    await Promise.resolve();
    stub.reply({
      requestId: prompt.requestId,
      decision: 'deny',
    });

    expect((await pending).decision).toBe('deny');
  });

  test('denies when nobody answers before the timeout', async () => {
    const stub = channelStub();
    const outcome = await askUserForPermission({
      timeout: 10,
    })(request(), stub.ctx, INFO);

    // An unattended prompt must not become an approval by running out the clock.
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason).toContain('timed out');
  });

  test('an explicit onTimeout overrides the default denial', async () => {
    const stub = channelStub();
    const outcome = await askUserForPermission({
      timeout: 10,
      onTimeout: {
        decision: 'cancel',
        reason: 'reviewer unavailable',
      },
    })(request(), stub.ctx, INFO);

    expect(outcome.decision).toBe('cancel');
    expect(outcome.reason).toBe('reviewer unavailable');
  });

  test('falls back to the tool call id when the agent sent no title', async () => {
    const stub = channelStub();
    const pending = askUserForPermission({
      timeout: 10,
    })(
      request({
        toolCall: {
          toolCallId: 'call-9',
        },
      }),
      stub.ctx,
      INFO,
    );

    await Promise.resolve();
    expect(stub.sent[0]?.title).toBe('call-9');
    await pending;
  });
});

describe('askUserForPermission — topic delivery race', () => {
  /**
   * A stub faithful to TOPIC semantics: a send reaches only subscribers that
   * are parked at that moment, and is DROPPED otherwise. The forgiving stub
   * above queues instead, which is why it cannot see this class of bug.
   */
  function topicStub(): {
    ctx: Context;
    /** Answer as soon as a request is published, in the same tick. */
    onRequest(fn: (prompt: AcpPermissionPrompt) => AcpPermissionReply): void;
  } {
    let waiter: ((value: AcpPermissionReply) => void) | null = null;
    let responder: ((prompt: AcpPermissionPrompt) => AcpPermissionReply) | null = null;

    const ctx = frameworkCast<Context>({
      threadId: 'thread-1',
      async send(channel: Channel<unknown>, value: unknown) {
        if (channel.name !== acpPermissionRequests.name || !responder) {
          return;
        }
        const reply = responder(frameworkCast<AcpPermissionPrompt>(value));
        // Topic: delivered only if someone is parked right now, else dropped.
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(reply);
        }
      },
      recv(
        _channel: Channel<unknown>,
        opts?: {
          timeout?: number;
        },
      ) {
        return new Promise<AcpPermissionReply>((resolve, reject) => {
          const timer =
            opts?.timeout === undefined
              ? undefined
              : setTimeout(() => reject(new Error('channel_timeout')), opts.timeout);
          waiter = (value) => {
            if (timer) {
              clearTimeout(timer);
            }
            resolve(value);
          };
        });
      },
    });

    return {
      ctx,
      onRequest(fn) {
        responder = fn;
      },
    };
  }

  // Regression: the handler used to publish the request and only then park on
  // the decision topic. A reviewer answering immediately answered into the
  // void, and the agent's turn stalled until the timeout — a denial, for a
  // request a human had explicitly allowed.
  test('an answer delivered the instant the request lands is not missed', async () => {
    const stub = topicStub();
    stub.onRequest((prompt) => ({
      requestId: prompt.requestId,
      decision: 'allow',
      optionId: 'yes',
    }));

    const outcome = await askUserForPermission({
      timeout: 50,
    })(request(), stub.ctx, INFO);

    expect(outcome.decision).toBe('allow');
    expect(outcome.optionId).toBe('yes');
  });
});

describe('permission channel shapes', () => {
  test('requests are a queue so each is reviewed exactly once', () => {
    expect(acpPermissionRequests.mode).toBe('queue');
    expect(acpPermissionRequests.external).toBe(true);
  });

  test('decisions are a topic so every parked handler can filter', () => {
    expect(acpPermissionDecisions.mode).toBe('topic');
    expect(acpPermissionDecisions.external).toBe(true);
  });
});
