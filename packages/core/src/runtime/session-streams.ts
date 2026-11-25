import type {
  Item,
  ItemSchemaRegistry,
  SdkStreamEvent,
  StreamEvent,
  StreamingItem,
} from '@noetic-tools/types';
import { defaultItemSchemaRegistry, frameworkCast } from '@noetic-tools/types';
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

type AccumulatorUpdate = (acc: ItemAccumulator, event: StreamEvent) => void;

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

/** The id of the item an SDK event is about, when the event names one. */
function itemIdOf(event: SdkStreamEvent): string | undefined {
  const { itemId, item } = event.data;
  if (typeof itemId === 'string') {
    return itemId;
  }
  return isItemRecord(item) && typeof item.id === 'string' ? item.id : undefined;
}

/** Framework-authored snapshots: a custom item in progress, or an appended item. */
function* frameworkSnapshots(event: StreamEvent): Generator<StreamingItem> {
  // A custom item's event streams in progress under the id its final item takes.
  if (event.type.endsWith(':custom_item_event')) {
    yield frameworkCast<StreamingItem>({
      ...event.data,
      isComplete: false,
    });
    return;
  }
  if (
    event.type.endsWith(':item_appended') &&
    typeof event.data.item === 'object' &&
    event.data.item !== null
  ) {
    yield {
      ...frameworkCast<Item>(event.data.item),
      isComplete: true,
    };
  }
}

/** How each delta event changes the item it is about. */
const ACCUMULATOR_UPDATES: Record<string, AccumulatorUpdate | undefined> = {
  'response.output_text.delta': updateMessageAccumulator,
  'response.output_text.done': updateMessageAccumulator,
  'response.function_call_arguments.delta': updateFunctionCallAccumulator,
  'response.function_call_arguments.done': updateFunctionCallAccumulator,
};

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

/**
 * @internal Yield cumulative StreamingItem snapshots.
 *
 * SDK events cover model output only; framework-authored items — turn input
 * messages, between-rounds injections, tool results — arrive via the
 * `item_appended` framework event and are yielded already complete.
 */
export async function* buildItemStream(
  broadcaster: EventBroadcaster,
  itemSchemas: ItemSchemaRegistry = defaultItemSchemaRegistry,
): AsyncIterable<StreamingItem> {
  const stream = new ItemStream(itemSchemas);
  for await (const event of broadcaster) {
    yield* stream.push(event);
  }
}

//#endregion

//#region ItemStream

/**
 * @internal Folds stream events into item snapshots, one event at a time: what
 * `getItemStream` yields and what an `OutputStore` keeps.
 *
 * An event that names its item is matched by that id, which keeps model calls
 * running at once apart. One that does not is matched by round and output index,
 * the round counted from `response.created`, so the items of later tool rounds
 * and later turns do not collide.
 */
export class ItemStream {
  private readonly accumulators = new Map<string, ItemAccumulator>();
  private readonly byId = new Map<string, ItemAccumulator>();
  private roundOffset = 0;
  private readonly itemSchemas: ItemSchemaRegistry;

  constructor(itemSchemas: ItemSchemaRegistry = defaultItemSchemaRegistry) {
    this.itemSchemas = itemSchemas;
  }

  /** The snapshots `event` produces: none, or one. */
  *push(event: StreamEvent): Generator<StreamingItem> {
    if (event.source === 'framework') {
      yield* frameworkSnapshots(event);
      return;
    }
    if (event.source !== 'sdk') {
      return;
    }
    if (event.type === 'response.created') {
      this.roundOffset++;
      return;
    }
    if (event.type === 'response.output_item.added') {
      yield* this.add(event);
      return;
    }
    if (event.type === 'response.output_item.done') {
      const acc = this.find(event, -1);
      if (acc) {
        acc.isComplete = true;
        yield completeStreamingItem(acc.item);
      }
      return;
    }
    const update = ACCUMULATOR_UPDATES[event.type];
    const acc = update ? this.find(event, 0) : undefined;
    if (update && acc) {
      update(acc, event);
      yield {
        ...acc.item,
        isComplete: acc.isComplete,
      };
    }
  }

  private *add(event: SdkStreamEvent): Generator<StreamingItem> {
    const outputIndex =
      typeof event.outputIndex === 'number' ? event.outputIndex : this.accumulators.size;
    const acc = createAccumulatorFromItemAdded(event, this.itemSchemas);
    if (!acc) {
      return;
    }
    this.accumulators.set(accumulatorKey(this.roundOffset, outputIndex), acc);
    this.byId.set(acc.id, acc);
    yield {
      ...acc.item,
      isComplete: false,
    };
  }

  /** The accumulator `event` is about. `missingIndex` stands in for an absent output index. */
  private find(event: SdkStreamEvent, missingIndex: number): ItemAccumulator | undefined {
    const id = itemIdOf(event);
    // An event that names its item must never fall through to another call's output index.
    if (id !== undefined) {
      return this.byId.get(id);
    }
    const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : missingIndex;
    return this.accumulators.get(accumulatorKey(this.roundOffset, outputIndex));
  }
}

//#endregion
