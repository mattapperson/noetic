import type { Context } from '../types/context';
import type {
  HarnessResponse,
  HarnessResult,
  StreamEvent,
  StreamingItem,
} from '../types/harness-result';
import type { EventBroadcaster } from './event-broadcaster';

//#region Types

/** Mutable message item used internally for accumulation. */
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

/** Mutable function call item used internally for accumulation. */
interface MutableFunctionCallItem {
  id: string;
  type: 'function_call';
  status: 'in_progress' | 'completed';
  callId: string;
  name: string;
  arguments: string;
}

type MutableItem = MutableMessageItem | MutableFunctionCallItem;

interface ItemAccumulator {
  id: string;
  item: MutableItem;
  isComplete: boolean;
}

//#endregion

//#region Helper Functions

function buildHarnessResponse(text: string, ctx: Context): HarnessResponse {
  return {
    items: ctx.itemLog.items,
    usage: {
      inputTokens: ctx.tokens.input,
      outputTokens: ctx.tokens.output,
    },
    cost: ctx.cost > 0 ? ctx.cost : undefined,
    text,
  };
}

async function* filterTextStream(broadcaster: EventBroadcaster): AsyncIterable<string> {
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

async function* filterReasoningStream(broadcaster: EventBroadcaster): AsyncIterable<string> {
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

function updateMessageAccumulator(acc: ItemAccumulator, event: StreamEvent): void {
  if (event.source !== 'sdk') {
    return;
  }
  if (event.type === 'response.output_text.delta' && typeof event.data.delta === 'string') {
    const msg = acc.item;
    if (msg.type !== 'message') {
      return;
    }
    const lastPart = msg.content[msg.content.length - 1];
    if (lastPart) {
      lastPart.text += event.data.delta;
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
    if (fc.type !== 'function_call') {
      return;
    }
    fc.arguments += event.data.delta;
  }
  if (event.type === 'response.function_call_arguments.done') {
    acc.isComplete = true;
  }
}

function isItemRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function createAccumulatorFromItemAdded(event: StreamEvent): ItemAccumulator | null {
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
    return {
      id,
      item: {
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

  return null;
}

async function* buildItemStream(broadcaster: EventBroadcaster): AsyncIterable<StreamingItem> {
  const accumulators = new Map<number, ItemAccumulator>();

  for await (const event of broadcaster) {
    if (event.source !== 'sdk') {
      continue;
    }

    // New output item added
    if (event.type === 'response.output_item.added') {
      const outputIndex =
        typeof event.outputIndex === 'number' ? event.outputIndex : accumulators.size;
      const acc = createAccumulatorFromItemAdded(event);
      if (acc) {
        accumulators.set(outputIndex, acc);
        yield {
          ...acc.item,
          isComplete: false,
        };
      }
      continue;
    }

    // Output item done
    if (event.type === 'response.output_item.done') {
      const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : -1;
      const acc = accumulators.get(outputIndex);
      if (acc) {
        acc.isComplete = true;
        yield {
          ...acc.item,
          status: 'completed',
          isComplete: true,
        };
      }
      continue;
    }

    // Text delta
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : 0;
      const acc = accumulators.get(outputIndex);
      if (acc) {
        updateMessageAccumulator(acc, event);
        yield {
          ...acc.item,
          isComplete: acc.isComplete,
        };
      }
      continue;
    }

    // Function call argument delta
    if (
      event.type === 'response.function_call_arguments.delta' ||
      event.type === 'response.function_call_arguments.done'
    ) {
      const outputIndex = typeof event.outputIndex === 'number' ? event.outputIndex : 0;
      const acc = accumulators.get(outputIndex);
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

/** Creates an AsyncIterable that throws on first iteration. */
function errorIterable<T>(err: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.reject(err);
        },
      };
    },
  };
}

//#endregion

//#region HarnessResultImpl

/**
 * Implementation of HarnessResult that wraps an EventBroadcaster and execution promise.
 *
 * @internal
 */
export class HarnessResultImpl implements HarnessResult {
  private readonly broadcaster: EventBroadcaster;
  private readonly executionPromise: Promise<string>;
  private readonly ctx: Context;

  constructor(broadcaster: EventBroadcaster, executionPromise: Promise<string>, ctx: Context) {
    this.broadcaster = broadcaster;
    this.executionPromise = executionPromise;
    this.ctx = ctx;
  }

  async getText(): Promise<string> {
    return this.executionPromise;
  }

  async getResponse(): Promise<HarnessResponse> {
    const text = await this.executionPromise;
    return buildHarnessResponse(text, this.ctx);
  }

  getTextStream(): AsyncIterable<string> {
    return filterTextStream(this.broadcaster);
  }

  getReasoningStream(): AsyncIterable<string> {
    return filterReasoningStream(this.broadcaster);
  }

  getItemStream(): AsyncIterable<StreamingItem> {
    return buildItemStream(this.broadcaster);
  }

  getFullStream(): AsyncIterable<StreamEvent> {
    return this.broadcaster;
  }

  /** Create a HarnessResult where all accessors reject with the given error. */
  static fromError(err: Error): HarnessResult {
    return new ErrorHarnessResult(err);
  }
}

//#endregion

//#region ErrorHarnessResult

class ErrorHarnessResult implements HarnessResult {
  private readonly err: Error;

  constructor(err: Error) {
    this.err = err;
  }

  async getText(): Promise<string> {
    throw this.err;
  }

  async getResponse(): Promise<HarnessResponse> {
    throw this.err;
  }

  getTextStream(): AsyncIterable<string> {
    return errorIterable(this.err);
  }

  getReasoningStream(): AsyncIterable<string> {
    return errorIterable(this.err);
  }

  getItemStream(): AsyncIterable<StreamingItem> {
    return errorIterable(this.err);
  }

  getFullStream(): AsyncIterable<StreamEvent> {
    return errorIterable(this.err);
  }
}

//#endregion
