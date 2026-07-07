/**
 * Streaming output-dialect contracts for `step.llm`.
 *
 * An `OutputCodec` is the dialect-agnostic alternative to a Zod schema in
 * `StepLLM.output`: instead of JSON-parsing the assistant text once at turn
 * end, a codec is fed each text delta as it streams and produces a typed
 * value when the turn finishes. OpenUI Lang is one dialect; the contract
 * lives here — next to `MemoryLayer` and `SubHarness` — so `core` and
 * dialect packages both depend on it without forming a cycle.
 */

/**
 * Emitter handed to a codec session so it can surface framework events
 * (e.g. `openui.node`) while a turn streams. Events flow through the
 * executing step's normal framework-event surface and respect the step's
 * `emit` gate.
 * @public
 */
export type OutputCodecEventEmitter = (type: string, data: Record<string, unknown>) => void;

/**
 * A stateful parse of one turn's streamed output. Codecs are stateful while
 * a turn streams, so the interpreter starts one session per turn.
 * @public
 */
export interface OutputCodecSession<O = unknown> {
  /**
   * Fed each assistant text delta in stream order. Declared as a method
   * (bivariant params) so concrete sessions assign to the erased form.
   */
  push(delta: string, emit: OutputCodecEventEmitter): void;
  /**
   * Called once at turn end with the full assistant text. Returns the typed
   * output. Throwing here surfaces through the same error path as a Zod
   * structured-output parse failure.
   */
  finish(fullText: string): O;
}

/**
 * A streaming output dialect for `step.llm`. Discriminated from a Zod schema
 * in `StepLLM.output` by the `kind: 'codec'` tag.
 * @public
 */
export interface OutputCodec<O = unknown> {
  kind: 'codec';
  /** Appended to the step's system instructions (e.g. a generated component-library prompt). */
  instructions?: string;
  /** One session per turn. */
  start(): OutputCodecSession<O>;
}

/**
 * Narrows a `StepLLM.output` value to an `OutputCodec`. A Zod schema has no
 * `kind: 'codec'` tag, so the discriminant is unambiguous.
 * @public
 */
export function isOutputCodec<O>(value: unknown): value is OutputCodec<O> {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('start' in value)) {
    return false;
  }
  const record: Record<string, unknown> = value;
  return record.kind === 'codec' && typeof record.start === 'function';
}
