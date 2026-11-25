/**
 * A nested agent's events (spec 08 § Nested agents) reach the full stream and
 * nothing else: the text, reasoning and item streams are the run's own output.
 */

import { describe, expect, it } from 'bun:test';
import type { AgentScope, StreamEvent } from '@noetic-tools/types';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import {
  buildItemStream,
  filterReasoningStream,
  filterTextStream,
  ItemStream,
} from '../../src/runtime/session-streams';

const CHILD: AgentScope = {
  id: 'step/agent:child',
  title: 'Explore',
};

function sdk(
  type: string,
  data: Record<string, unknown>,
  where: {
    scope?: AgentScope;
    outputIndex?: number;
  } = {},
): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
    ...(where.outputIndex === undefined
      ? {}
      : {
          outputIndex: where.outputIndex,
        }),
    ...(where.scope
      ? {
          scope: where.scope,
        }
      : {}),
  };
}

const MESSAGE = {
  id: 'm',
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [
    {
      type: 'output_text',
      text: '',
    },
  ],
};

/** A turn: the root and a nested agent each stream a message, interleaved. */
const EVENTS: StreamEvent[] = [
  sdk('response.created', {}),
  sdk(
    'response.created',
    {},
    {
      scope: CHILD,
    },
  ),
  sdk(
    'response.output_item.added',
    {
      item: MESSAGE,
    },
    {
      outputIndex: 0,
    },
  ),
  sdk(
    'response.output_item.added',
    {
      item: {
        ...MESSAGE,
        id: 'c',
      },
    },
    {
      scope: CHILD,
      outputIndex: 0,
    },
  ),
  sdk(
    'response.output_text.delta',
    {
      delta: 'child says',
    },
    {
      scope: CHILD,
      outputIndex: 0,
    },
  ),
  sdk(
    'response.reasoning.delta',
    {
      delta: 'child thinks',
    },
    {
      scope: CHILD,
    },
  ),
  sdk(
    'response.output_text.delta',
    {
      delta: 'root says',
    },
    {
      outputIndex: 0,
    },
  ),
  sdk('response.reasoning.delta', {
    delta: 'root thinks',
  }),
  {
    source: 'framework',
    type: 'h:item_appended',
    data: {
      item: {
        id: 'x',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'child item',
          },
        ],
      },
    },
    scope: CHILD,
  },
];

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of stream) {
    out.push(value);
  }
  return out;
}

function broadcasting(): EventBroadcaster {
  const broadcaster = new EventBroadcaster();
  return broadcaster;
}

describe('a nested agent on the stream', () => {
  it('never reaches the text or reasoning streams', async () => {
    const text = broadcasting();
    const texts = collect(filterTextStream(text));
    const reasoning = broadcasting();
    const thoughts = collect(filterReasoningStream(reasoning));
    for (const event of EVENTS) {
      text.emit(event);
      reasoning.emit(event);
    }
    text.complete();
    reasoning.complete();
    expect(await texts).toEqual([
      'root says',
    ]);
    expect(await thoughts).toEqual([
      'root thinks',
    ]);
  });

  it('never reaches the item stream, whose indexes stay the root’s', async () => {
    const broadcaster = broadcasting();
    const items = collect(buildItemStream(broadcaster));
    for (const event of EVENTS) {
      broadcaster.emit(event);
    }
    broadcaster.complete();
    const seen = await items;
    expect(seen.map((item) => ('id' in item ? item.id : undefined))).toEqual([
      'm',
      'm',
    ]);
    expect(JSON.stringify(seen)).not.toContain('child');
  });

  it('ItemStream folds nothing from a scoped event', () => {
    const stream = new ItemStream();
    const scoped = EVENTS.filter((event) => event.scope !== undefined);
    expect(
      scoped.flatMap((event) => [
        ...stream.push(event),
      ]),
    ).toEqual([]);
  });
});
