/**
 * A served run's held questions go to the editor when it can show forms, and
 * are declined when it cannot (spec 31, spec 27 § Questions the agent asks).
 */

import { describe, expect, it } from 'bun:test';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { ExecuteArgument, HeldCall, StreamEvent } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { servedQuestionAnswerer } from '../src/serve-questions';
import type { AcpServeHarness } from '../src/serve-types';

const QUESTION: HeldCall = {
  callId: 'q1',
  name: 'claude-code:question',
  args: {
    message: 'Which branch?',
  },
  argsHash: 'h',
  reason: 'question',
  question: {
    message: 'Which branch?',
    schema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
        },
      },
      required: [
        'branch',
      ],
    },
  },
};

const HELD: StreamEvent = {
  source: 'framework',
  type: 'served:tool_call_held',
  data: {
    ...QUESTION,
  },
};

function servedHarness(events: StreamEvent[]): {
  harness: AcpServeHarness;
  executed: ExecuteArgument[];
} {
  const executed: ExecuteArgument[] = [];
  const harness = frameworkCast<AcpServeHarness>({
    async execute(input: ExecuteArgument) {
      executed.push(input);
    },
    async *getFullStream() {
      yield* events;
    },
  });
  return {
    harness,
    executed,
  };
}

function editor(answer: acp.CreateElicitationResponse): {
  conn: AgentSideConnection;
  asked: acp.CreateElicitationRequest[];
} {
  const asked: acp.CreateElicitationRequest[] = [];
  const conn = frameworkCast<AgentSideConnection>({
    async createElicitation(request: acp.CreateElicitationRequest) {
      asked.push(request);
      return answer;
    },
  });
  return {
    conn,
    asked,
  };
}

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('forwardServedQuestions', () => {
  it('puts a held question to an editor that can show forms, and passes its answer back', async () => {
    const { harness, executed } = servedHarness([
      HELD,
    ]);
    const { conn, asked } = editor({
      action: 'accept',
      content: {
        branch: 'main',
      },
    });
    const forwarding = servedQuestionAnswerer({
      conn,
      harness,
      sessionId: 'sess',
      capabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    forwarding(HELD);
    await settle(() => executed.length > 0);
    expect(asked[0]?.message).toBe('Which branch?');
    expect(executed).toEqual([
      {
        type: 'noetic:decision',
        callId: 'q1',
        argsHash: 'h',
        output: {
          branch: 'main',
        },
      },
    ]);
  });

  it('declines a held question when the editor cannot show forms', async () => {
    const { harness, executed } = servedHarness([
      HELD,
    ]);
    const { conn, asked } = editor({
      action: 'cancel',
    });
    const forwarding = servedQuestionAnswerer({
      conn,
      harness,
      sessionId: 'sess',
      capabilities: {},
    });
    forwarding(HELD);
    await settle(() => executed.length > 0);
    expect(asked).toEqual([]);
    expect(executed).toEqual([
      {
        type: 'noetic:decision',
        callId: 'q1',
        argsHash: 'h',
        action: 'deny',
      },
    ]);
  });

  it("an editor's decline declines; its cancel leaves the question held", async () => {
    const declined = servedHarness([
      HELD,
    ]);
    const declining = servedQuestionAnswerer({
      conn: editor({
        action: 'decline',
      }).conn,
      harness: declined.harness,
      sessionId: 'sess',
      capabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    declining(HELD);
    await settle(() => declined.executed.length > 0);
    expect(declined.executed).toEqual([
      {
        type: 'noetic:decision',
        callId: 'q1',
        argsHash: 'h',
        action: 'deny',
      },
    ]);

    const cancelled = servedHarness([
      HELD,
    ]);
    const { conn, asked } = editor({
      action: 'cancel',
    });
    const cancelling = servedQuestionAnswerer({
      conn,
      harness: cancelled.harness,
      sessionId: 'sess',
      capabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    cancelling(HELD);
    await settle(() => asked.length > 0);
    expect(cancelled.executed).toEqual([]);
  });

  it('declines when the editor fails the request, or when its answer is refused', async () => {
    const failed = servedHarness([]);
    const failing = servedQuestionAnswerer({
      conn: frameworkCast<AgentSideConnection>({
        async createElicitation() {
          throw new Error('Method not found');
        },
      }),
      harness: failed.harness,
      sessionId: 'sess',
      capabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    failing(HELD);
    await settle(() => failed.executed.length > 0);
    expect(failed.executed).toEqual([
      {
        type: 'noetic:decision',
        callId: 'q1',
        argsHash: 'h',
        action: 'deny',
      },
    ]);

    const executed: ExecuteArgument[] = [];
    const refusing = servedQuestionAnswerer({
      conn: editor({
        action: 'accept',
        content: {
          wrong: 'field',
        },
      }).conn,
      harness: frameworkCast<AcpServeHarness>({
        async execute(input: ExecuteArgument) {
          executed.push(input);
          if (JSON.stringify(input).includes('"output"')) {
            throw new Error('hold_refused: the answer does not fit the question');
          }
        },
      }),
      sessionId: 'sess',
      capabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    refusing(HELD);
    await settle(() => executed.length > 1);
    expect(executed[1]).toEqual({
      type: 'noetic:decision',
      callId: 'q1',
      argsHash: 'h',
      action: 'deny',
    });
  });

  it('leaves every other held call alone', async () => {
    const { harness, executed } = servedHarness([
      {
        source: 'framework',
        type: 'served:tool_call_held',
        data: {
          ...QUESTION,
          reason: 'approval',
          question: undefined,
        },
      },
    ]);
    const forwarding = servedQuestionAnswerer({
      conn: editor({
        action: 'cancel',
      }).conn,
      harness,
      sessionId: 'sess',
      capabilities: {},
    });
    forwarding({
      source: 'framework',
      type: 'served:tool_call_held',
      data: {
        ...QUESTION,
        reason: 'approval',
        question: undefined,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executed).toEqual([]);
  });
});
