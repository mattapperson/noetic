import type { Context, Item, MessageItem, Step, StepEmitItemsResult } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';

//#region Public API

/**
 * Emits what a finished step asks to (`step.emitItems`): appends the items to the item
 * log and streams each as `item_appended` at once, so they reach `getItemStream` while
 * the rest of the workflow still runs. Like the SDK item events, it ignores
 * `step.emit` filtering. Each item is marked in the step's lane record, so the ledger
 * entry that holds it can stream it again on replay.
 *
 * @throws `NoeticError` with kind `item_schema_mismatch` when an item's type is not
 * one the context's item schemas accept.
 */
export async function emitStepItems<TContext, I, O>(
  step: Step<TContext, I, O>,
  output: O,
  ctx: Context<TContext>,
): Promise<void> {
  const option = step.emitItems;
  if (!option) {
    return;
  }
  const items = toItems(option === true ? outputText(output) : await option(output, ctx));
  for (const item of items) {
    appendEmitted(ctx, item);
    streamItem(ctx, item);
  }
}

/**
 * Puts a replayed entry's items back on the log. The ones at `emitted` (the entry's
 * `streamed` indices) keep their mark, so a parent that records on this resumed run
 * carries it on, and stream again as `item_appended` when the harness sets
 * `emitItemsOnReplay`. The rest go back quietly, as all of them do by default.
 */
export function appendReplayed<TContext>(
  ctx: Context<TContext>,
  items: ReadonlyArray<Item>,
  emitted: ReadonlyArray<number>,
): void {
  const marked = new Set(emitted);
  const stream = ctx.harness.config.emitItemsOnReplay === true;
  items.forEach((item, i) => {
    if (!marked.has(i)) {
      ctx.itemLog.append(item);
      return;
    }
    appendEmitted(ctx, item);
    if (stream) {
      streamItem(ctx, item);
    }
  });
}

//#endregion

//#region Helpers

function appendEmitted<TContext>(ctx: Context<TContext>, item: Item): void {
  if (ctx instanceof ContextImpl) {
    ctx.appendEmitted(item);
    return;
  }
  ctx.itemLog.append(item);
}

function streamItem<TContext>(ctx: Context<TContext>, item: Item): void {
  emitFrameworkEvent({
    broadcaster: getBroadcaster(frameworkCast<Context>(ctx)),
    agentName: ctx.harness.config.name,
    eventType: 'item_appended',
    data: {
      item,
    },
  });
}

function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output;
  }
  return output === undefined || output === null ? undefined : JSON.stringify(output);
}

function toItems(result: StepEmitItemsResult): Item[] {
  if (result === undefined || result === '') {
    return [];
  }
  if (typeof result === 'string') {
    return [
      assistantMessage(result),
    ];
  }
  return isItemList(result)
    ? [
        ...result,
      ]
    : [
        result,
      ];
}

function isItemList(
  result: Exclude<StepEmitItemsResult, string | undefined>,
): result is ReadonlyArray<Item> {
  return Array.isArray(result);
}

function assistantMessage(text: string): MessageItem {
  return {
    id: `emitted-${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

//#endregion
