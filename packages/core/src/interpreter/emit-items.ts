import type {
  Context,
  CustomItem,
  CustomItemMap,
  Item,
  MessageItem,
  Step,
  StepEmitItemsResult,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, validateSchema } from '@noetic-tools/types';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import { stepChildren } from './step-walk';

//#region Types

/** One step dispatch's custom item: the id its events and final item share. */
interface Emission {
  readonly id: string;
  readonly item: CustomItem;
  final: boolean;
}

type Hook = (value: unknown, ctx: Context<unknown>) => unknown;

//#endregion

//#region Constants

/** Open emissions, by the lane the dispatch runs on (one per dispatch). */
const emissions = new WeakMap<object, Emission>();

//#endregion

//#region Public API

/**
 * Starts what a step emits (spec 34 § Emitting): opens the dispatch's custom item, if
 * `emitItems` names one, and runs `onStart` with the step's input. Events stream at
 * once as `custom_item_event`; a final item appends and streams as `item_appended`.
 *
 * @throws `NoeticConfigError` with code `UNKNOWN_CUSTOM_ITEM`, `CUSTOM_ITEM_HAS_NO_EVENTS`,
 * `CUSTOM_ITEM_ALREADY_FINAL`, or `INVALID_CUSTOM_ITEM`.
 */
export async function beginEmitItems<TContext, I, O>(
  step: Step<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
): Promise<void> {
  const config = hookConfig(step);
  if (!config) {
    return;
  }
  if (config.item !== undefined) {
    emissions.set(ctx, {
      id: `item-${crypto.randomUUID()}`,
      item: resolveItem(step, config.item),
      final: false,
    });
  }
  if (config.onStart) {
    await runHook(step, config.onStart, input, ctx);
  }
}

/**
 * Finishes what a step emits: runs `onDone` with its output, or for `emitItems: true`
 * emits the output itself as a final item, or for a function emits what it returns.
 * Like the SDK item events, none of it is subject to `step.emit` filtering.
 *
 * @throws `NoeticConfigError` as `beginEmitItems`, and `NoeticError` with kind
 * `item_schema_mismatch` when a standard item's type is not one the context accepts.
 */
export async function emitStepItems<TContext, I, O>(
  step: Step<TContext, I, O>,
  output: O,
  ctx: Context<TContext>,
): Promise<void> {
  try {
    const option = step.emitItems;
    if (!option) {
      return;
    }
    if (option === true) {
      await emitOutput(step, output, ctx);
      return;
    }
    if (typeof option === 'function') {
      appendAll(ctx, toItems(await option(output, ctx)));
      return;
    }
    if (option.onDone) {
      await runHook(step, frameworkCast<Hook>(option.onDone), output, ctx);
    }
  } finally {
    emissions.delete(ctx);
  }
}

/**
 * Streams one event a generator `runCode` yielded, as an event of the item its
 * `emitItems` names.
 *
 * @throws `NoeticConfigError` with code `CUSTOM_ITEM_HAS_NO_EVENTS` or `INVALID_CUSTOM_ITEM`.
 */
export async function emitStepEvent<TContext>(
  stepId: string,
  event: unknown,
  ctx: Context<TContext>,
): Promise<void> {
  await emitEvent(stepId, openEmission(stepId, ctx), event, ctx);
}

/**
 * Runs a tool-style body to its return value: awaits a promise, or drains a
 * generator, passing each yield to `onYield`.
 */
export async function runToReturn(
  result: unknown,
  onYield: (value: unknown) => Promise<void>,
): Promise<unknown> {
  if (!isGenerator(result)) {
    return result;
  }
  while (true) {
    const next = await result.next();
    if (next.done) {
      return next.value;
    }
    await onYield(next.value);
  }
}

/**
 * Lets `ctx` accept the final items of every custom item `step` declares, before one
 * is appended or replayed from the ledger. Contexts created from `ctx` later inherit
 * the wider schemas.
 */
export function allowCustomItems<TContext, I, O>(
  step: Step<TContext, I, O>,
  ctx: Context<TContext>,
): void {
  const items = Object.values(step.customItems ?? {});
  if (items.length === 0 || !(ctx instanceof ContextImpl)) {
    return;
  }
  ctx.allowItemTypes(items.map((item) => item.type));
}

/**
 * Every custom item declared anywhere in `step`'s static tree, for a harness to accept
 * before it rebuilds or restores a log that may hold them.
 */
export function collectCustomItems(step: Step): CustomItem[] {
  return [
    ...Object.values(step.customItems ?? {}),
    ...stepChildren(step).flatMap(collectCustomItems),
  ];
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

//#region Hooks

function hookConfig<TContext, I, O>(
  step: Step<TContext, I, O>,
):
  | {
      item?: string;
      onStart?: Hook;
    }
  | undefined {
  const option = step.emitItems;
  if (typeof option !== 'object') {
    return undefined;
  }
  return {
    item: option.item,
    onStart: frameworkCast<Hook | undefined>(option.onStart),
  };
}

/**
 * Runs one hook. With an open emission, its yields are events and its return value
 * the final item's fields. Without one it gives text or standard items, and may not
 * yield.
 */
async function runHook<TContext, I, O>(
  step: Step<TContext, I, O>,
  hook: Hook,
  value: unknown,
  ctx: Context<TContext>,
): Promise<void> {
  const emission = emissions.get(ctx);
  const result = await runToReturn(hook(value, frameworkCast<Context<unknown>>(ctx)), (event) =>
    emitEvent(step.id, emission ?? noEvents(step.id), event, ctx),
  );
  if (!emission) {
    appendAll(ctx, toItems(frameworkCast<StepEmitItemsResult>(result)));
    return;
  }
  if (result !== undefined) {
    await emitFinal(emission, result, ctx);
  }
}

//#endregion

//#region Emitting

async function emitEvent<TContext>(
  stepId: string,
  emission: Emission,
  event: unknown,
  ctx: Context<TContext>,
): Promise<void> {
  const schema = emission.item.event;
  if (!schema) {
    noEvents(stepId, emission.item.type);
  }
  const checked = await validateSchema(schema, event);
  if (!checked.success) {
    throw invalid(emission.item.type, 'event', checked.issues);
  }
  emitFrameworkEvent({
    broadcaster: getBroadcaster(frameworkCast<Context>(ctx)),
    agentName: ctx.harness.config.name,
    eventType: 'custom_item_event',
    data: {
      id: emission.id,
      type: emission.item.type,
      event: checked.value,
    },
  });
}

async function emitFinal<TContext>(
  emission: Emission,
  fields: unknown,
  ctx: Context<TContext>,
): Promise<void> {
  if (emission.final) {
    throw new NoeticConfigError({
      code: 'CUSTOM_ITEM_ALREADY_FINAL',
      message: `Custom item '${emission.item.type}' (${emission.id}) got a second final item in one dispatch.`,
      hint: 'Return the final fields from one hook only: onStart or onDone, not both.',
    });
  }
  emission.final = true;
  const item = await finalItem(emission.item, emission.id, fields);
  appendEmitted(ctx, item);
  streamItem(ctx, item);
}

/** `emitItems: true`: the output is the final item, of a custom type when its `type` names one. */
async function emitOutput<TContext, I, O>(
  step: Step<TContext, I, O>,
  output: O,
  ctx: Context<TContext>,
): Promise<void> {
  const custom = customOutput(step.customItems, output);
  if (!custom) {
    appendAll(ctx, toItems(outputItems(output)));
    return;
  }
  const { id: _id, type: _type, ...fields } = custom.value;
  const item = await finalItem(custom.item, `item-${crypto.randomUUID()}`, fields);
  appendEmitted(ctx, item);
  streamItem(ctx, item);
}

async function finalItem(item: CustomItem, id: string, fields: unknown): Promise<Item> {
  const checked = await validateSchema(item.output, fields);
  if (!checked.success) {
    throw invalid(item.type, 'output', checked.issues);
  }
  if (typeof checked.value !== 'object' || checked.value === null) {
    throw invalid(item.type, 'output', [
      {
        message: 'A final item must be an object of fields.',
      },
    ]);
  }
  return frameworkCast<Item>({
    ...checked.value,
    id,
    type: item.type,
  });
}

function appendAll<TContext>(ctx: Context<TContext>, items: ReadonlyArray<Item>): void {
  for (const item of items) {
    appendEmitted(ctx, item);
    streamItem(ctx, item);
  }
}

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

//#endregion

//#region Helpers

function resolveItem<TContext, I, O>(step: Step<TContext, I, O>, name: string): CustomItem {
  const item = step.customItems?.[name];
  if (!item) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_CUSTOM_ITEM',
      message: `Step '${step.id}' emits custom item '${name}', which is not in its scope.`,
      hint: 'Declare it on the step (customItems) or, in a JSON workflow, at the document root.',
    });
  }
  return item;
}

function openEmission<TContext>(stepId: string, ctx: Context<TContext>): Emission {
  return emissions.get(ctx) ?? noEvents(stepId);
}

function noEvents(stepId: string, type?: string): never {
  throw new NoeticConfigError({
    code: 'CUSTOM_ITEM_HAS_NO_EVENTS',
    message:
      type === undefined
        ? `Step '${stepId}' yielded an event, but its emitItems names no item.`
        : `Step '${stepId}' yielded an event for custom item '${type}', which declares no event schema.`,
    hint: "Name an item with an event schema: emitItems: { item: 'progress' }, with customItem({ type, event, output }).",
  });
}

function invalid(
  type: string,
  phase: 'event' | 'output',
  issues: ReadonlyArray<{
    message: string;
  }>,
): NoeticConfigError {
  return new NoeticConfigError({
    code: 'INVALID_CUSTOM_ITEM',
    message: `Custom item '${type}' got an ${phase} that does not match its schema: ${issues.map((issue) => issue.message).join('; ')}`,
    hint: `Make the ${phase} match the '${phase}' schema declared with customItem({ type: '${type}' }).`,
  });
}

/**
 * The custom item an output is, when its `type` names one in scope. JSON workflow nodes
 * pass output as text, so a string is read as JSON first.
 */
function customOutput(
  items: CustomItemMap | undefined,
  raw: unknown,
):
  | {
      item: CustomItem;
      value: Record<string, unknown>;
    }
  | undefined {
  const output = typeof raw === 'string' ? parseJson(raw) : raw;
  if (typeof output !== 'object' || output === null || !('type' in output)) {
    return undefined;
  }
  const item = Object.values(items ?? {}).find((candidate) => candidate.type === output.type);
  return item
    ? {
        item,
        value: Object.fromEntries(Object.entries(output)),
      }
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function outputItems(output: unknown): StepEmitItemsResult {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output === 'object' && output !== null && 'type' in output) {
    return frameworkCast<Item>(output);
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

function isGenerator(
  value: unknown,
): value is AsyncGenerator<unknown, unknown> | Generator<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'next' in value &&
    typeof value.next === 'function' &&
    (Symbol.asyncIterator in value || Symbol.iterator in value)
  );
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
