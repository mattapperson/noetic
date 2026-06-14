/**
 * Accumulates a stream of {@link SubHarnessStreamPart}s into a
 * {@link SubHarnessTurnResult}. Adapters feed every part they receive from the
 * underlying agent (optionally forwarding each to the step's `emit` sink) and
 * call {@link SubHarnessTurnAccumulator.result} when the turn ends.
 */

import type {
  Item,
  SubHarnessFinishReason,
  SubHarnessStreamPart,
  SubHarnessTurnResult,
  TokenUsage,
} from '@noetic-tools/types';
import { assistantMessageItem, functionCallItem } from './items';

interface CollectedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Fill in a `total` when the stream reports input/output but no total. */
function normalizeUsage(usage: {
  input: number;
  output: number;
  total?: number;
  cached?: number;
}): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total ?? usage.input + usage.output,
    cached: usage.cached,
  };
}

/** @public Options for {@link SubHarnessTurnAccumulator}. */
export interface SubHarnessTurnAccumulatorOptions {
  /** Forward each part to this sink as it is pushed (e.g. the step's `emit`). */
  emit?: (part: SubHarnessStreamPart) => void;
}

/** @public Accumulates stream parts into a turn result. */
export class SubHarnessTurnAccumulator {
  private text = '';
  private reasoning = '';
  private readonly toolCalls: CollectedToolCall[] = [];
  private usage?: TokenUsage;
  private cost?: number;
  private finishReason?: SubHarnessFinishReason;
  private readonly emitSink?: (part: SubHarnessStreamPart) => void;

  constructor(options: SubHarnessTurnAccumulatorOptions = {}) {
    this.emitSink = options.emit;
  }

  /** Feed one stream part. Forwards it to the emit sink, then accumulates. */
  push(part: SubHarnessStreamPart): void {
    this.emitSink?.(part);
    if (part.type === 'text-delta') {
      this.text += part.delta;
      return;
    }
    if (part.type === 'reasoning-delta') {
      this.reasoning += part.delta;
      return;
    }
    if (part.type === 'tool-call') {
      this.toolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
      return;
    }
    if (part.type === 'finish') {
      this.usage = part.usage ? normalizeUsage(part.usage) : undefined;
      this.cost = part.cost;
      this.finishReason = part.finishReason;
    }
  }

  /** The accumulated assistant text so far. */
  get textContent(): string {
    return this.text;
  }

  /** The accumulated reasoning text so far. */
  get reasoningContent(): string {
    return this.reasoning;
  }

  /** Build the turn result. Overrides win over values seen in the stream. */
  result(overrides?: {
    usage?: TokenUsage;
    cost?: number;
    harnessMetadata?: Record<string, unknown>;
  }): SubHarnessTurnResult {
    const items: Item[] = [];
    if (this.text.length > 0) {
      items.push(assistantMessageItem(this.text));
    }
    for (const call of this.toolCalls) {
      items.push(
        functionCallItem({
          name: call.toolName,
          input: call.input,
          callId: call.toolCallId,
        }),
      );
    }
    return {
      items,
      text: this.text,
      usage: overrides?.usage ?? this.usage,
      cost: overrides?.cost ?? this.cost,
      finishReason: this.finishReason,
      harnessMetadata: overrides?.harnessMetadata,
    };
  }
}
