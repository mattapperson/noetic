/**
 * Maps an ACP turn's `session/update` notifications onto the harness's
 * observable event surface.
 *
 * Every one of the protocol's eight update variants is translated into the same
 * `source: 'sdk'` broadcaster events the model-call path emits, so a coding
 * agent's text, reasoning, and tool calls flow through `getTextStream()` /
 * `getReasoningStream()` / `getItemStream()` / `getFullStream()` exactly like an
 * LLM step's output. Each notification is *also* re-emitted raw as an
 * `acp_event` framework event for consumers that want the protocol payload.
 *
 * `finalize()` guarantees a turn always emits its output: if an agent returns a
 * stop reason without streaming any text or tool calls, the result's content is
 * synthesized into events.
 */

import type {
  AcpClientActivity,
  AcpSessionNotification,
  AcpTurnResult,
  Context,
  ContextData,
  StepAcpAgent,
} from '@noetic-tools/types';
import type { EmitOption } from '../runtime/broadcaster-utils';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import { isFunctionCall } from './typeguards';

type SessionUpdate = AcpSessionNotification['update'];

/** Flatten an ACP content block for the text event surface. */
function blockText(
  block: Extract<
    SessionUpdate,
    {
      content: unknown;
    }
  >['content'],
): string {
  if (block.type === 'text') {
    return block.text;
  }
  if (block.type === 'resource_link') {
    return `[resource: ${block.uri}]`;
  }
  if (block.type === 'resource') {
    return 'text' in block.resource ? block.resource.text : `[resource: ${block.resource.uri}]`;
  }
  return `[${block.type}: ${block.mimeType}]`;
}

export class AcpEventBridge {
  private readonly broadcaster?: EventBroadcaster;
  private readonly agentName: string;
  private readonly stepId: string;
  private readonly agentId: string;
  private readonly emitOption: EmitOption | undefined;
  private started = false;
  private completed = false;
  private nextOutputIndex = 0;
  private messageOutputIndex: number | null = null;
  private sawText = false;
  /** Tool call ids already announced, so a `tool_call_update` never re-opens one. */
  private readonly announcedToolCalls = new Set<string>();

  constructor(step: Pick<StepAcpAgent, 'id' | 'emit'>, agentId: string, ctx: Context<ContextData>) {
    this.broadcaster = getBroadcaster(ctx);
    this.agentName = ctx.harness.config.name;
    this.stepId = step.id;
    this.agentId = agentId;
    this.emitOption = step.emit;
  }

  /**
   * Open the turn on the event surface. Emits `response.created` so every turn
   * brackets with a lifecycle marker — even an agent that streams nothing.
   */
  begin(): void {
    this.start();
  }

  /**
   * Record one client-side operation the agent performed. Unlike a `tool_call`
   * update — which is the agent's own account of what it did — this is what it
   * actually asked us to do, refusals included.
   */
  forwardActivity(activity: AcpClientActivity): void {
    if (!this.broadcaster) {
      return;
    }
    const data = {
      stepId: this.stepId,
      agentId: this.agentId,
      ...activity,
    };
    if (!shouldEmit(this.emitOption, 'acp_client_activity', data)) {
      return;
    }
    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType: 'acp_client_activity',
      data,
    });
  }

  /** Forward one notification: a structured framework event + the mapped sdk events. */
  forward(notification: AcpSessionNotification): void {
    if (!this.broadcaster) {
      return;
    }
    const data = {
      stepId: this.stepId,
      agentId: this.agentId,
      sessionId: notification.sessionId,
      update: notification.update,
    };
    if (shouldEmit(this.emitOption, 'acp_event', data)) {
      emitFrameworkEvent({
        broadcaster: this.broadcaster,
        agentName: this.agentName,
        eventType: 'acp_event',
        data,
      });
    }
    this.translate(notification.update);
  }

  /**
   * Ensure the turn's output reached the event surface. For an agent that
   * returns a result without streaming, synthesize events from the result.
   */
  finalize(result: AcpTurnResult): void {
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
    for (const item of result.items) {
      if (isFunctionCall(item) && !this.announcedToolCalls.has(item.callId)) {
        this.emitToolCall(item.callId, item.name, item.arguments);
      }
    }
    this.closeMessage();
    if (!this.completed) {
      this.start();
      this.sdk('response.completed', {
        stopReason: result.stopReason,
      });
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
    const id = `acp-msg-${crypto.randomUUID()}`;
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
    this.announcedToolCalls.add(toolCallId);
  }

  private translate(update: SessionUpdate): void {
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.openMessage();
      this.sdk(
        'response.output_text.delta',
        {
          delta: blockText(update.content),
        },
        this.messageOutputIndex ?? 0,
      );
      this.sawText = true;
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.start();
      this.sdk('response.reasoning.delta', {
        delta: blockText(update.content),
      });
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      this.closeMessage();
      this.emitToolCall(update.toolCallId, update.title, update.rawInput);
      return;
    }
    // `user_message_chunk` (replayed history), `tool_call_update`, `plan`,
    // `available_commands_update`, and `current_mode_update` have no model-stream
    // analogue; they surface on the full stream under their protocol names.
    this.sdk(`acp.${update.sessionUpdate}`, {
      update,
    });
  }

  //#endregion
}
