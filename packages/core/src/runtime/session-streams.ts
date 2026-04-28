import type { ItemSchemaRegistry } from '../schemas/item';
import { defaultItemSchemaRegistry } from '../schemas/item';
import type { StreamEvent, StreamingItem } from '../types/harness-result';
import type { Item } from '../types/items';
import type { EventBroadcaster } from './event-broadcaster';

//#region Types

interface MutableMessageItem {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'in_progress' | 'completed';
  content: Array<{
    type: 'output_text';
    text: string;
  }>;
}

interface MutableFunctionCallItem {
  id: string;
  type: 'function_call';
  status: 'in_progress' | 'completed';
  callId: string;
  name: string;
  arguments: string;
}

type MutableItem = MutableMessageItem | MutableFunctionCallItem | Item;

interface ItemAccumulator {
  id: string;
  item: MutableItem;
  isComplete: boolean;
}

//#endregion

//#region Helpers

function isItemRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function appendText(
  part: {
    readonly text: string;
  },
  delta: string,
): void {
  Object.assign(part, {
    text: part.text + delta,
  });
}

function createAccumulatorFromItemAdded(
  event: StreamEvent,
  itemSchemas: ItemSchemaRegistry,
): ItemAccumulator | null {
  if (event.source !== 'sdk' || event.type !== 'response.output_item.added') {
    return null;
  }
  if (!isItemRecord(event.data.item)) {
    return null;
  }
  const itemData = event.data.item;
  const id = typeof itemData.id === 'string' ? itemData.id : crypto.randomUUID();

  if (itemData.type === 'message') {
    return {
      id,
      item: {
        id,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [
          {
            type: 'output_text',
            text: '',
          },
        ],
      },
      isComplete: false,
    };
  }

  if (itemData.type === 'function_call') {
    const parsed = itemSchemas.parse(itemData);
    return {
      id,
      item: {
        ...parsed,
        id,
        type: 'function_call',
        status: 'in_progress',
        callId: typeof itemData.callId === 'string' ? itemData.callId : '',
        name: typeof itemData.name === 'string' ? itemData.name : '',
        arguments: '',
      },
      isComplete: false,
    };
  }

  const parsed = itemSchemas.parse(itemData);
  return {
    id,
    item: parsed,
    isComplete: false,
  };
}

function updateMessageAccumulator(acc: ItemAccumulator, event: StreamEvent): void {
  if (event.source !== 'sdk') {
    return;
  }
  if (event.type === 'response.output_text.delta' && typeof event.data.delta === 'string') {
    const msg = acc.item;
    if (msg.type !== 'message' || !('content' in msg)) {
      return;
    }
    const lastPart = msg.content[msg.content.length - 1];
    if (lastPart && 'text' in lastPart && typeof lastPart.text === 'string') {
      appendText(lastPart, event.data.delta);
    }
  }
  if (event.type === 'response.output_text.done') {
    acc.isComplete = true;
  }
}

function updateFunctionCallAccumulator(acc: ItemAccumulator, event: StreamEvent): void {
  if (event.source !== 'sdk') {
    return;
  }
  if (
    event.type === 'response.function_call_arguments.delta' &&
    typeof event.data.delta === 'string'
  ) {
    const fc = acc.item;
    if (fc.type !== 'function_call' || !('arguments' in fc) || typeof fc.arguments !== 'string') {
      return;
    }
    fc.arguments += event.data.delta;
  }
  if (event.type === 'response.function_call_arguments.done') {
    acc.isComplete = true;
  }
}

/** Compute a composite key from round offset and output index to avoid collisions across tool rounds. */
function accumulatorKey(roundOffset: number, outputIndex: number): string {
  return `${roundOffset}:${outputIndex}`;
}

function completeStreamingItem(item: MutableItem): MutableItem & {
  isComplete: true;
} {
  if ('status' in item) {
    return {
      ...item,
      status: 'completed',
      isComplete: true,
    };
  }
  return {
    ...item,
    isComplete: true,
  };
}

//#endregion

//#region Public stream filters

/** @internal Yield text deltas from the session broadcaster. */
export async function* filterTextStream(broadcaster: EventBroadcaster): AsyncIterable<string> {
  for await (const event of broadcaster) {
    if (event.source !== 'sdk' || event.type !== 'response.output_text.delta') {
      continue;
    }
    const delta = event.data.delta;
    if (typeof delta === 'string') {
      yield delta;
    }
  }
}

/** @internal Yield reasoning-token deltas from the session broadcaster. */
export async function* filterReasoningStream(broadcaster: EventBroadcaster): AsyncIterable<string> {
  for await (const event of broadcaster) {
    if (event.source !== 'sdk' || event.type !== 'response.reasoning.delta') {
      continue;
    }
    const delta = event.data.delta;
    if (typeof delta === 'string') {
      yield delta;
    }
  }
}

/** @internal Yield cumulative StreamingItem snapshots. Uses roundOffset keyed by
 *  response.created so accumulators across multiple tool rounds and across
 *  multiple turns within a session don't collide. */
export async function* buildItemStream(
  broadcaster: EventBroadcaster,
  itemSchemas: ItemSchemaRegistry = defaultItemSchemaRegistry,
): AsyncIterable<StreamingItem> {
  const accumulators = new Map<string, ItemAccumulator>();
  let roundOffset = 0;

  for await (const event of broadcaster) {
    if (event.source !== 'sdk') {
      continue;
    }

    if (event.type === 'response.created') {
      roundOffset++;
      continue;
    }

    if (event.type === 'response.output_item.added') {
      const outputIndex =
        typeof event.outputIndex === 'number' ? event.outputIndex : accumulators.size;
      const key = accumulatorKey(roundOffset, outputIndex);
      const acc = createAccumulatorFromItemAdded(event, itemSchemas);
      if (acc) {
        accumulators.set(key, acc);
        yield {
          ...acc.item,
          isComplete: false,
        };
      }
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : -1;
      const key = accumulatorKey(roundOffset, outputIndex);
      const acc = accumulators.get(key);
      if (acc) {
        acc.isComplete = true;
        yield completeStreamingItem(acc.item);
      }
      continue;
    }

    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : 0;
      const key = accumulatorKey(roundOffset, outputIndex);
      const acc = accumulators.get(key);
      if (acc) {
        updateMessageAccumulator(acc, event);
        yield {
          ...acc.item,
          isComplete: acc.isComplete,
        };
      }
      continue;
    }

    if (
      event.type === 'response.function_call_arguments.delta' ||
      event.type === 'response.function_call_arguments.done'
    ) {
      const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : 0;
      const key = accumulatorKey(roundOffset, outputIndex);
      const acc = accumulators.get(key);
      if (acc) {
        updateFunctionCallAccumulator(acc, event);
        yield {
          ...acc.item,
          isComplete: acc.isComplete,
        };
      }
    }
  }
}

//#endregion
