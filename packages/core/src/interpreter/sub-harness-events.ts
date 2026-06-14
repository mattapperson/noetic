/**
 * Maps a sub-harness turn's output onto the harness's observable event surface.
 *
 * A sub-harness adapter emits {@link SubHarnessStreamPart}s; this bridge
 * translates each one into the same `source: 'sdk'` broadcaster events the
 * model-call path emits, so a coding agent's text, reasoning, and tool calls
 * flow through `getTextStream()` / `getReasoningStream()` / `getItemStream()` /
 * `getFullStream()` exactly like an LLM step's output. It also re-emits the raw
 * part as a `sub_harness_event` framework event for harness-native consumers.
 *
 * `finalize()` guarantees a turn always emits its output: if an adapter returns
 * a result without streaming any text/tool parts, the result's content is
 * synthesized into events.
 */

import type {
  Context,
  ContextMemory,
  StepSubHarness,
  SubHarnessStreamPart,
  SubHarnessTurnResult,
} from '@noetic-tools/types';
import type { EmitOption } from '../runtime/broadcaster-utils';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import { isFunctionCall } from './typeguards';

export class SubHarnessEventBridge {
  private readonly broadcaster?: EventBroadcaster;
  private readonly agentName: string;
  private readonly stepId: string;
  private readonly stepKind: string;
  private readonly emitOption: EmitOption | undefined;
  private started = false;
  private completed = false;
  private nextOutputIndex = 0;
  private messageOutputIndex: number | null = null;
  private sawText = false;
  private sawToolCall = false;

  constructor(step: Pick<StepSubHarness, 'id' | 'kind' | 'emit'>, ctx: Context<ContextMemory>) {
    this.broadcaster = getBroadcaster(ctx);
    this.agentName = ctx.harness.config.name;
    this.stepId = step.id;
    this.stepKind = step.kind;
    this.emitOption = step.emit;
  }

  /**
   * Open the turn on the event surface. Emits `response.created` so every turn
   * always brackets with a lifecycle marker — even a custom adapter that
   * streams nothing still emits output.
   */
  begin(): void {
    this.start();
  }

  /** Forward one stream part: a structured framework event + the mapped sdk events. */
  forward(part: SubHarnessStreamPart): void {
    if (!this.broadcaster) {
      return;
    }
    const data = {
      stepId: this.stepId,
      kind: this.stepKind,
      part,
    };
    if (shouldEmit(this.emitOption, 'sub_harness_event', data)) {
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'sub_harness_event',
        data,
      });
    }
    this.translate(part);
  }

  /**
   * Ensure the turn's output reached the event surface. For adapters that
   * return a result without streaming, synthesize events from the result.
   */
  finalize(result: SubHarnessTurnResult): void {
    if (!this.broadcaster) {
      return;
    }
    if (!this.sawText && result.text.length > 0) {
      this.openMessage();
      this.sdk(
        'response.output_text.delta',
        {
          delta: result.text,
        },
        this.messageOutputIndex ?? 0,
      );
      this.sawText = true;
    }
    if (!this.sawToolCall) {
      for (const item of result.items) {
        if (isFunctionCall(item)) {
          this.emitToolCall(item.callId, item.name, item.arguments);
        }
      }
    }
    this.closeMessage();
    // Always close the turn so every turn emits a completion marker.
    if (!this.completed) {
      this.start();
      this.sdk('response.completed', {});
      this.completed = true;
    }
  }

  //#region internals

  private sdk(type: string, data: Record<string, unknown>, outputIndex?: number): void {
    if (!this.broadcaster) {
      return;
    }
    if (!shouldEmit(this.emitOption, type, data)) {
      return;
    }
    this.broadcaster.emit({
      source: 'sdk',
      type,
      data,
      outputIndex,
    });
  }

  private start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.sdk('response.created', {});
  }

  private openMessage(): void {
    if (this.messageOutputIndex !== null) {
      return;
    }
    this.start();
    const id = `sub-harness-msg-${crypto.randomUUID()}`;
    this.messageOutputIndex = this.nextOutputIndex++;
    this.sdk(
      'response.output_item.added',
      {
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
      },
      this.messageOutputIndex,
    );
  }

  private closeMessage(): void {
    if (this.messageOutputIndex === null) {
      return;
    }
    const index = this.messageOutputIndex;
    this.sdk('response.output_text.done', {}, index);
    this.sdk('response.output_item.done', {}, index);
    this.messageOutputIndex = null;
  }

  private emitToolCall(toolCallId: string, name: string, input: unknown): void {
    this.start();
    const index = this.nextOutputIndex++;
    const args = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    this.sdk(
      'response.output_item.added',
      {
        item: {
          id: toolCallId,
          type: 'function_call',
          status: 'in_progress',
          callId: toolCallId,
          name,
          arguments: '',
        },
      },
      index,
    );
    this.sdk(
      'response.function_call_arguments.delta',
      {
        delta: args,
      },
      index,
    );
    this.sdk(
      'response.function_call_arguments.done',
      {
        arguments: args,
      },
      index,
    );
    this.sdk('response.output_item.done', {}, index);
    this.sawToolCall = true;
  }

  private translate(part: SubHarnessStreamPart): void {
    if (part.type === 'stream-start') {
      this.start();
      return;
    }
    if (part.type === 'text-delta') {
      this.openMessage();
      this.sdk(
        'response.output_text.delta',
        {
          delta: part.delta,
        },
        this.messageOutputIndex ?? 0,
      );
      this.sawText = true;
      return;
    }
    if (part.type === 'reasoning-delta') {
      this.start();
      this.sdk('response.reasoning.delta', {
        delta: part.delta,
      });
      return;
    }
    if (part.type === 'tool-call') {
      this.closeMessage();
      this.emitToolCall(part.toolCallId, part.toolName, part.input);
      return;
    }
    if (part.type === 'finish') {
      this.closeMessage();
      this.sdk('response.completed', {
        finishReason: part.finishReason,
      });
      this.completed = true;
      return;
    }
    // file-change | tool-result | error | raw — surfaced on the full stream only.
    this.sdk(`sub_harness.${part.type}`, {
      part,
    });
  }

  //#endregion
}
