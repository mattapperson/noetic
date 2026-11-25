import { describe, expect, it } from 'bun:test';
import type { HeldCall, HeldCallSettled, StreamEvent } from '../src';
import { readHeldCallEvent } from '../src';

function framework(type: `${string}:${string}`, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'framework',
    type,
    data,
  };
}

const HELD: HeldCall = {
  callId: 'call_1',
  name: 'refund',
  args: {
    amount: 1,
  },
  argsHash: 'h1',
  reason: 'approval',
};

describe('readHeldCallEvent', () => {
  it('reads a held call', () => {
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_held', {
          ...HELD,
        }),
      ),
    ).toEqual({
      type: 'held',
      call: HELD,
    });
  });

  it('reads a held question with its question, and its settlement', () => {
    const question: HeldCall = {
      ...HELD,
      name: 'claude-code:question',
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
        },
      },
    };
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_held', {
          ...question,
        }),
      ),
    ).toEqual({
      type: 'held',
      call: question,
    });
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_settled', {
          callId: question.callId,
          name: question.name,
          argsHash: question.argsHash,
          reason: 'question',
          by: 'answer',
        }),
      ),
    ).toEqual({
      type: 'settled',
      settled: {
        callId: question.callId,
        name: question.name,
        argsHash: question.argsHash,
        reason: 'question',
        by: 'answer',
      },
    });
  });

  it('keeps the optional fields a hold carries', () => {
    const read = readHeldCallEvent(
      framework('ops:tool_call_held', {
        ...HELD,
        reason: 'result',
        dueAt: 5,
        onDue: 'keep',
        request: {
          question: 'ok?',
        },
      }),
    );
    expect(read).toEqual({
      type: 'held',
      call: {
        ...HELD,
        reason: 'result',
        dueAt: 5,
        onDue: 'keep',
        request: {
          question: 'ok?',
        },
      },
    });
  });

  it("names a coding agent's call by the id a decision takes", () => {
    const read = readHeldCallEvent(
      framework('ops:tool_call_held', {
        ...HELD,
        callId: 'agent-7',
        heldAs: 'path/0',
      }),
    );
    expect(read).toMatchObject({
      type: 'held',
      call: {
        callId: 'path/0',
      },
    });
  });

  it('reads a settled call', () => {
    const settled: HeldCallSettled = {
      callId: 'call_1',
      name: 'refund',
      argsHash: 'h1',
      reason: 'outcome',
      by: 'skipped',
    };
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_settled', {
          ...settled,
        }),
      ),
    ).toEqual({
      type: 'settled',
      settled,
    });
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_settled', {
          ...settled,
          callId: 'agent-7',
          heldAs: 'path/0',
        }),
      ),
    ).toMatchObject({
      settled: {
        callId: 'path/0',
      },
    });
  });

  it('is undefined for other events, other harnesses, sdk events and data that does not fit', () => {
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_started', {
          ...HELD,
        }),
      ),
    ).toBeUndefined();
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_held', {
          ...HELD,
        }),
        'other',
      ),
    ).toBeUndefined();
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_held', {
          ...HELD,
        }),
        'ops',
      ),
    ).toBeDefined();
    expect(
      readHeldCallEvent({
        source: 'sdk',
        type: 'response.created',
        data: {
          ...HELD,
        },
      }),
    ).toBeUndefined();
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_held', {
          ...HELD,
          reason: 'maybe',
        }),
      ),
    ).toBeUndefined();
    expect(
      readHeldCallEvent(
        framework('ops:tool_call_settled', {
          ...HELD,
          by: 'nobody',
        }),
      ),
    ).toBeUndefined();
  });
});
