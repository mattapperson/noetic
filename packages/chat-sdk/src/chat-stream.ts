import type { StreamEvent } from '@noetic-tools/core';

//#region Helper

function isTextDelta(event: StreamEvent): boolean {
  return event.source === 'sdk' && event.type === 'response.output_text.delta';
}

function isToolRoundCompleted(event: StreamEvent): boolean {
  return event.source === 'framework' && event.type.endsWith(':tool_round_completed');
}

//#endregion

//#region Public API

/**
 * Convert a Noetic stream event iterable into an AsyncIterable<string> suitable for
 * chat-sdk's `thread.post()`. Equivalent to AI SDK's `fullStream` — yields text
 * deltas and injects paragraph breaks between tool rounds.
 *
 * @param source - Either an async iterable of stream events, or an object that
 *   exposes `getFullStream()` (e.g. `AgentHarness`).
 *
 * @public
 */
interface HasGetFullStream {
  getFullStream(): AsyncIterable<StreamEvent>;
}

function hasGetFullStream(value: object): value is HasGetFullStream {
  if (!('getFullStream' in value)) {
    return false;
  }
  const maybe: {
    getFullStream?: unknown;
  } = value;
  return typeof maybe.getFullStream === 'function';
}

export async function* chatStream(
  source: AsyncIterable<StreamEvent> | HasGetFullStream,
): AsyncIterable<string> {
  const stream = hasGetFullStream(source) ? source.getFullStream() : source;

  let hasEmittedText = false;

  for await (const event of stream) {
    if (isToolRoundCompleted(event)) {
      if (hasEmittedText) {
        yield '\n\n';
        hasEmittedText = false;
      }
      continue;
    }

    if (!isTextDelta(event)) {
      continue;
    }

    const delta = event.data.delta;
    if (typeof delta !== 'string') {
      continue;
    }

    hasEmittedText = true;
    yield delta;
  }
}

//#endregion
