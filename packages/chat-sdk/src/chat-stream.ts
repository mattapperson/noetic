import type { HarnessResult, StreamEvent } from '@noetic/core';

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
 * Convert a Noetic HarnessResult into an AsyncIterable<string> suitable for
 * chat-sdk's `thread.post()`. Equivalent to AI SDK's `fullStream` —
 * yields text deltas and injects paragraph breaks between tool rounds.
 *
 * @param result - The HarnessResult from harness.execute()
 * @returns AsyncIterable<string> compatible with thread.post()
 *
 * @public
 */
export async function* chatStream(result: HarnessResult): AsyncIterable<string> {
  let hasEmittedText = false;

  for await (const event of result.getFullStream()) {
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
