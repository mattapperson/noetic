import { describe, expect, test } from 'bun:test';
import { streamToChatChunks } from '../src/stream-to-chunks';
import { collect, fwEvent, sdkEvent } from './_helpers';

const MESSAGE_ID = 'msg-1';
const TURN = {
  turnId: 'turn-1',
  messageIds: [
    MESSAGE_ID,
  ],
};

function delta(text: string) {
  return sdkEvent('response.output_text.delta', {
    delta: text,
  });
}

function messageAdded(id: string) {
  return sdkEvent('response.output_item.added', {
    item: {
      id,
      type: 'message',
    },
  });
}

async function* asStream<T>(events: T[]): AsyncIterable<T> {
  yield* events;
}

describe('streamToChatChunks', () => {
  test('passes text deltas through and terminates on turn_completed', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          delta('Hello'),
          delta(' world'),
          fwEvent('turn_completed', {
            turnId: 'turn-1',
          }),
          delta('AFTER-END'),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'Hello',
      ' world',
    ]);
  });

  test('skips replayed events from earlier turns', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', {
            turnId: 'turn-0',
            messageIds: [
              'other',
            ],
          }),
          delta('stale'),
          fwEvent('turn_completed', {
            turnId: 'turn-0',
          }),
          fwEvent('turn_started', TURN),
          delta('fresh'),
          fwEvent('turn_completed', {
            turnId: 'turn-1',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'fresh',
    ]);
  });

  test('injects a separator between assistant messages, not before the first', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          messageAdded('a'),
          delta('first'),
          messageAdded('b'),
          delta('second'),
          fwEvent('turn_completed', {
            turnId: 'turn-1',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'first',
      '\n\n',
      'second',
    ]);
  });

  test('maps tool calls to task_update lifecycle chunks', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          fwEvent('tool_call_started', {
            name: 'search',
            callId: 'c1',
          }),
          fwEvent('tool_call_completed', {
            name: 'search',
            callId: 'c1',
            error: false,
          }),
          fwEvent('tool_call_started', {
            name: 'write',
            callId: 'c2',
          }),
          fwEvent('tool_call_completed', {
            name: 'write',
            callId: 'c2',
            error: true,
          }),
          fwEvent('turn_completed', {
            turnId: 'turn-1',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      {
        type: 'task_update',
        id: 'c1',
        title: 'search',
        status: 'in_progress',
      },
      {
        type: 'task_update',
        id: 'c1',
        title: 'search',
        status: 'complete',
      },
      {
        type: 'task_update',
        id: 'c2',
        title: 'write',
        status: 'in_progress',
      },
      {
        type: 'task_update',
        id: 'c2',
        title: 'write',
        status: 'error',
      },
    ]);
  });

  test('custom taskTitle renders the card title', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          fwEvent('tool_call_started', {
            name: 'search',
            callId: 'c1',
          }),
          fwEvent('turn_completed', {
            turnId: 'turn-1',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
          taskTitle: (name) => `Running ${name}`,
        },
      ),
    );
    expect(chunks).toEqual([
      {
        type: 'task_update',
        id: 'c1',
        title: 'Running search',
        status: 'in_progress',
      },
      // An unfinished call is flushed at the turn boundary so no card is
      // left spinning.
      {
        type: 'task_update',
        id: 'c1',
        title: 'Running search',
        status: 'complete',
      },
    ]);
  });

  test('turn_aborted yields a generic notice — never the raw internal reason', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          delta('partial'),
          fwEvent('turn_aborted', {
            turnId: 'turn-1',
            reason: 'ECONNRESET at /internal/path',
          }),
          delta('AFTER-END'),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'partial',
      '\n\n_(turn aborted)_',
    ]);
  });

  test('abortNotice can rewrite or suppress the notice; no text means no separator', async () => {
    const abortEvents = () => [
      fwEvent('turn_started', TURN),
      fwEvent('turn_aborted', {
        turnId: 'turn-1',
        reason: 'boom',
      }),
    ];
    const rewritten = await collect(
      streamToChatChunks(asStream(abortEvents()), {
        messageId: MESSAGE_ID,
        abortNotice: (reason) => `stopped: ${reason}`,
      }),
    );
    expect(rewritten).toEqual([
      'stopped: boom',
    ]);

    const suppressed = await collect(
      streamToChatChunks(asStream(abortEvents()), {
        messageId: MESSAGE_ID,
        abortNotice: () => null,
      }),
    );
    expect(suppressed).toEqual([]);
  });

  test('turn_aborted flushes open task cards as errors before the notice', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          fwEvent('tool_call_started', {
            name: 'search',
            callId: 'c1',
          }),
          fwEvent('turn_aborted', {
            turnId: 'turn-1',
            reason: 'stop',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      {
        type: 'task_update',
        id: 'c1',
        title: 'search',
        status: 'in_progress',
      },
      {
        type: 'task_update',
        id: 'c1',
        title: 'search',
        status: 'error',
      },
      '_(turn aborted)_',
    ]);
  });

  test('a coalesced turn is claimed only by the first messageId', async () => {
    const events = () => [
      fwEvent('turn_started', {
        turnId: 'turn-1',
        messageIds: [
          'first',
          'second',
        ],
      }),
      delta('shared'),
      fwEvent('turn_completed', {
        turnId: 'turn-1',
      }),
    ];
    const winner = await collect(
      streamToChatChunks(asStream(events()), {
        messageId: 'first',
      }),
    );
    const loser = await collect(
      streamToChatChunks(asStream(events()), {
        messageId: 'second',
      }),
    );
    expect(winner).toEqual([
      'shared',
    ]);
    expect(loser).toEqual([]);
  });

  test('an inbox_injected claim streams the running turn and ends at its boundary', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', {
            turnId: 'turn-9',
            messageIds: [
              'other',
            ],
          }),
          fwEvent('inbox_injected', {
            round: 2,
            count: 1,
            messageIds: [
              MESSAGE_ID,
            ],
          }),
          delta('joined late'),
          fwEvent('turn_completed', {
            turnId: 'turn-9',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'joined late',
    ]);
  });

  test('matches framework events regardless of harness name prefix', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN, 'my-agent'),
          delta('hi'),
          fwEvent(
            'turn_completed',
            {
              turnId: 'turn-1',
            },
            'my-agent',
          ),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'hi',
    ]);
  });

  test("another turn's turn_completed does not terminate the stream", async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          delta('a'),
          fwEvent('turn_completed', {
            turnId: 'turn-other',
          }),
          delta('b'),
          fwEvent('turn_completed', {
            turnId: 'turn-1',
          }),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'a',
      'b',
    ]);
  });

  test('ends without error when the source stream completes mid-turn', async () => {
    const chunks = await collect(
      streamToChatChunks(
        asStream([
          fwEvent('turn_started', TURN),
          delta('cut'),
        ]),
        {
          messageId: MESSAGE_ID,
        },
      ),
    );
    expect(chunks).toEqual([
      'cut',
    ]);
  });
});
