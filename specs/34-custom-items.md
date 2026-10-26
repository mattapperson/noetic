# Custom Items

> **Depends On:** `01-step-type` (Step, § Emitting items), `02-step-variants` (runCode, tool), `07-context-and-event-log` (Item, ItemLog), `08-runtime` (AgentHarness, getItemStream, getFullStream), `23a-step-level-resume` (ledger `items`/`streamed`), `26-json-workflow-runtime` (WorkflowDocument, WorkflowNode, subflow), `33-expressions` (Expression)
> **Exports:** `customItem()`, `isCustomItem()`, `isCustomItemEvent()`, `CustomItem`, `CustomItemMap`, `CustomItemOf`, `CustomItemEventOf`, `ItemShape`, `JsonSchema`, `FromJsonSchema`, `StepEmitItemsConfig`, `EmitHook`, `CustomStreamingItem`

---

## Purpose

A workflow often has something to show that is neither a model reply nor its final output: a progress bar, a search hit, a draft that fills in as a loop runs. `emitItems` (spec 01) lets a step add items to the conversation as it finishes, but an item's shape is only checked at run time against loosely typed schema lists, and nothing in the harness's result types knows it exists.

Custom items make those shapes part of the workflow. A workflow declares each item it can emit, the way a tool declares its input, events, and output. The declaration validates every emit, and it types the harness's results: `getItemStream()`, `getFullStream()`, and `getAgentResponse()` carry exactly the declared items, narrowed by `type`, not an open `Record<string, unknown>`.

An item streams the way a model reply does. While a step works on it, it yields **events**; when it is done, it gives one **final** item. Events and the final item share one id.

---

## Declaring an Item

`customItem()` mirrors `tool()` and `toolWithGenerator()`: a name, an optional description, an optional `event` schema for what streams, and an `output` schema for the final item.

```typescript
const progress = customItem({
  type: 'myapp:progress',
  description: 'How far a batch job has got.',
  event: z.object({ done: z.number() }),
  output: z.object({ done: z.number(), of: z.number() }),
});
```

```typescript
function customItem<T extends `${string}:${string}`, E extends ItemShape, O extends ItemShape>(config: {
  type: T;
  description?: string;
  event?: E;
  output: O;
}): CustomItem<T, InferShape<E>, InferShape<O>>;

type ItemShape = StandardSchemaV1 | JsonSchema;
```

- **`type`** follows the Open Responses convention for extension items: `prefix:name`, where the prefix names the vendor or domain. A type without a colon throws `INVALID_CUSTOM_ITEM_TYPE` (standard item types never contain one, which is what keeps the two apart).
- **`event`** and **`output`** each take a Standard Schema (Zod, Valibot, …) or a JSON Schema object. A JSON Schema validates through `z.fromJSONSchema`, so no code is generated and the check runs on Workers. Its static type comes from `FromJsonSchema`, which reads an `as const` schema (see § JSON Schema Types).
- **`output`** describes the item's own fields. It must describe an object, and it must not declare `id` or `type`; the runtime adds both. A shape that breaks either rule throws `INVALID_CUSTOM_ITEM_SHAPE` when it is declared.
- Without `event`, the item has no events: it arrives only as a final item.

### The item and its events

A final item is `{ id, type, ...output }`. An event is the payload `event` describes. Both are tied to one emit by `id`.

```typescript
type CustomItemOf<C> = C extends CustomItem<infer T, unknown, infer O> ? { id: string; type: T } & O : never;
type CustomItemEventOf<C> = C extends CustomItem<infer T, infer E, unknown> ? { id: string; type: T; event: E } : never;
```

The runtime registers every declared item with the context's item schemas, so a final item appends to the log like any other item and `item_schema_mismatch` guards it the same way.

---

## Where Items Are Declared

### Workflow root

A workflow declares items for every step in it. In TypeScript, `workflow()` takes them as `customItems`:

```typescript
const flow = workflow({ id: 'flow', document, customItems: { progress } });
```

A JSON document declares them in its root `customItems` map, with JSON Schema:

```jsonc
{
  "version": 1,
  "customItems": {
    "progress": {
      "type": "myapp:progress",
      "event": { "type": "object", "properties": { "done": { "type": "number" } }, "required": ["done"] },
      "output": { "type": "object", "properties": { "done": { "type": "number" }, "of": { "type": "number" } }, "required": ["done", "of"] }
    }
  },
  "root": { "kind": "loop", "id": "work", … }
}
```

When both name an item, they must agree on its `type`, or `workflow()` throws `CUSTOM_ITEM_MISMATCH` when it hydrates. The TypeScript declaration then validates and types the item. The document's JSON Schema serves for items only the document declares. The two schemas are not compared: one Zod schema renders as several equivalent JSON Schemas, so a structural comparison would reject agreeing pairs.

### On a step

Any step, programmatic or JSON, may declare `customItems` of its own. A step-level item can be emitted only by that step. A root item can be emitted by any step in the workflow.

```typescript
runCode({ id: 'fetch', customItems: { page }, emitItems: { item: 'page', onDone: (out) => ({ url: out.url }) }, execute });
```

```jsonc
{ "kind": "compute", "id": "tick", "expr": "…",
  "customItems": { "tick": { "type": "myapp:tick", "output": { … } } },
  "emitItems": { "item": "tick", "onDone": "{ 'n': n }" } }
```

A step resolves an item name against its own `customItems` first, then the workflow root. An unknown name throws `UNKNOWN_CUSTOM_ITEM` when the step hydrates (JSON) or builds (programmatic).

### Sub-workflows

A `subflow` runs a document with its own root. Its steps see that root's items and the enclosing workflow's. A name declared at both levels resolves to the subflow's own. The enclosing workflow's types include every item an inline subflow declares. A `ref` subflow's document is only known at run time, so its items are validated then but do not join the types; declare them at the enclosing root (or in `workflow({ customItems })`) to type them.

---

## Emitting

`emitItems` (spec 01 § Emitting items) gains a hook form.

```typescript
type StepEmitItemsOption<TContext, I, O> = boolean | StepEmitItemsFn<TContext, O> | StepEmitItemsConfig<TContext, I, O>;

interface StepEmitItemsConfig<TContext, I, O, N extends string = string> {
  /** The declared item this step emits. Without it, hooks give text or standard items only. */
  item?: N;
  /** Runs when the step starts, with its input. */
  onStart?: EmitHook<TContext, I>;
  /** Runs when the step finishes, with its output. */
  onDone?: EmitHook<TContext, O>;
}

type EmitHook<TContext, V, E = unknown, F = unknown> = (value: V, ctx: Context<TContext>) =>
  | F | undefined | Promise<F | undefined>
  | Generator<E, F | undefined> | AsyncGenerator<E, F | undefined>;
```

A hook is shaped like a tool's `execute`: a plain, async, generator, or async generator function. Each value it **yields** is an event of the step's `item`, validated against the item's `event` schema. What it **returns** is the item's final fields, validated against `output`. Returning `undefined` gives no final item from that hook.

- One emit owns one id for the whole dispatch: `onStart`'s events, a generator `runCode`'s yields, and `onDone`'s events all stream under it, and the final item takes it too.
- At most one final item per dispatch. A second one throws `CUSTOM_ITEM_ALREADY_FINAL`.
- A dispatch that yields events but never returns a final item leaves the item stream-only: it appears in `getItemStream` and `getFullStream`, never in the log.
- A hook that yields when the config names no `item`, or names one without an `event` schema, throws `CUSTOM_ITEM_HAS_NO_EVENTS`.
- Without `item`, a hook returns what a `StepEmitItemsFn` returns (text, a standard `Item`, or a list), and it may not yield.

**`emitItems: true`** emits the step's output as a final item with no events. A string becomes an assistant message (as before). An object whose `type` names a custom item in scope becomes that item: its fields are validated against `output`, and `id` is added. Any other `Item` is appended as given. `false` emits nothing.

### Generator `runCode`

`runCode`'s `execute`, like a tool's, may be a generator or async generator. Its yields are events of the item the step's `emitItems` names; its return value is the step's output. A generator `runCode` without an `emitItems` item throws `CUSTOM_ITEM_HAS_NO_EVENTS` when built. A JSON `runCode` node runs in a subprocess and cannot yield.

### JSON nodes

A JSON node's hooks are expressions (spec 33):

```jsonc
"emitItems": { "item": "progress", "onStart": "{ 'done': 0 }", "onDone": "{ 'done': n, 'of': total }" }
```

- **`onStart`** is evaluated against the node's input. Its value is one **event** of the item.
- **`onDone`** is evaluated against the node's output. Its value is the **final** item's fields.
- Without `item`, `onDone` gives message text (a string), as `{ "expr" }` did before, and `onStart` is not allowed.
- An expression that gives no value emits nothing for that hook.

Inside a loop, each iteration is its own dispatch, so each one emits its own item. A loop that reports on itself declares `emitItems` on the loop node: `onStart` once with the loop's input, then `onDone` with its final output.

---

## Streams and Results

### `getFullStream()`

Each event streams raw as it is produced, as a framework event:

```typescript
{ source: 'framework', type: `${agent}:custom_item_event`, data: { id, type, event } }
```

The final item streams as `item_appended`, as every framework-authored item does (spec 08).

### `getItemStream()`

A custom item streams the way a model reply does. Each event arrives as an in-progress entry; the final item arrives complete. `isComplete` tells them apart, and both carry the same `id`:

```typescript
type CustomStreamingItem<C> =
  | (CustomItemEventOf<C> & { isComplete: false })
  | (CustomItemOf<C> & { isComplete: true });
```

### `getAgentResponse()`

`HarnessResponse.items` holds final items only: every standard item plus each declared custom item's final form.

### Typing the harness

`workflow()` returns a step branded with the items it can emit: its TypeScript `customItems`, plus every item an `as const` document declares at its root, on a node, or in an inline subflow, typed from the JSON Schema by `FromJsonSchema`. A document typed as the plain `WorkflowDocument` contributes nothing to the types; its items are still validated at run time. The brand is a type-only property, `'~customItems'` (`CustomItemsBrand<C>`), kept apart from `customItems`: every step has a `customItems` field typed as the wide `CustomItemMap`, which would swamp inference. `AgentHarness` reads the brand off `agentGraph`:

```typescript
class AgentHarness<TParams, TItems extends CustomItemMap = {}> {
  getItemStream(scope?): AsyncIterable<StreamingItem | CustomStreamingItem<TItems[keyof TItems]>>;
  getFullStream(scope?): AsyncIterable<StreamEvent | CustomItemStreamEvent<TItems[keyof TItems]>>;
  getAgentResponse(scope?): Promise<HarnessResponse<Item | CustomItemOf<TItems[keyof TItems]>>>;
}
```

`isCustomItem(value, item)` narrows a result to one declared item, keyed by the declaration: an entry from `getItemStream()` to that item's events or final form, an item from `getAgentResponse()` to its final form. `isCustomItemEvent(event, item)` narrows a `getFullStream()` event to the item's raw `custom_item_event`. Comparing `item.type` alone cannot narrow, because the standard `Item` union holds server-tool items whose `type` is any `prefix:name`, and a template-literal member is not removed by comparing against a literal. A harness whose graph declares no items keeps today's types exactly.

A programmatic step built with `customItems` (`runCode`) carries the brand of its own items. Composite builders do not union their children's brands, so the items a harness types are those of its `agentGraph` step itself. Make the graph a `workflow()`, or declare the items on the step at its root.

At run time, the harness accepts every custom item declared anywhere in its graph's static tree (and every item a `workflow()` document declares) into its item schemas when it is constructed, so a log that holds them restores and rebuilds before any step runs. Each step also widens its context to its own items when it dispatches, before any replay.

---

## On Resume

A custom item's final form is an `Item`, so the ledger records it with the step's other `items`, marked in `streamed` (spec 23a). A replay re-appends it quietly; `emitItemsOnReplay` also streams it again as `item_appended`. Events are not recorded: they described work in progress, and a replayed step did its work in an earlier run.

---

## JSON Schema Types

`FromJsonSchema<S>` maps an `as const` JSON Schema to a type. It covers what item shapes need:

| Schema | Type |
|---|---|
| `{ type: 'string' }`, `'number'`, `'integer'`, `'boolean'`, `'null'` | the primitive |
| `{ enum: [...] }`, `{ const: v }` | the literal union |
| `{ type: 'array', items: S }` | `FromJsonSchema<S>[]` |
| `{ type: 'object', properties, required }` | an object; keys in `required` are required, the rest optional |
| `{ anyOf: [...] }`, `{ oneOf: [...] }` | the union |
| a `type` array, e.g. `['string', 'null']` | the union |

Anything else maps to `unknown`, which validation still checks at run time. A schema typed as a plain `JsonSchema` (not `as const`, e.g. loaded at run time) maps to `Record<string, unknown>`.

---

## Errors

All are `NoeticConfigError`s (spec 09).

| Code | When |
|---|---|
| `INVALID_CUSTOM_ITEM_TYPE` | A declared `type` has no `prefix:` part. |
| `INVALID_CUSTOM_ITEM_SHAPE` | `output` does not describe an object, or declares `id` or `type`. |
| `CUSTOM_ITEM_MISMATCH` | `workflow()` and its document declare one name with different `type`s. |
| `UNKNOWN_CUSTOM_ITEM` | `emitItems.item`, or the `type` of an `emitItems: true` output, names no item in scope. |
| `CUSTOM_ITEM_HAS_NO_EVENTS` | A hook or generator `runCode` yields for a step that names no item, or names one without `event`. |
| `CUSTOM_ITEM_ALREADY_FINAL` | A dispatch gives a second final item. |
| `INVALID_CUSTOM_ITEM` | An event or final value fails its schema. Carries the item `type`, the phase (`event` or `output`), and the schema's issues. |

---

## Design Notes

- **Why a separate `event` shape rather than partial finals.** A model reply streams deltas that the client folds into the reply. A custom item's events are whatever its producer wants to say while it works ("3 of 10 pages"), which is rarely a partial copy of the final item. A tool already makes this split (`event` vs `output`), and the item follows it.
- **Why step-level scope.** An item a single step emits is part of that step's contract, like a tool's output. Declaring it on the step keeps the declaration next to the only code allowed to produce it.
- **Why the harness type comes from `agentGraph`.** The graph is the one value that knows what can run. Asking callers to repeat the item map on the harness would let the two drift.
