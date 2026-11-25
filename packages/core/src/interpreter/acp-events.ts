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
  AcpChildUpdate,
  AcpClientActivity,
  AcpSessionNotification,
  AcpTurnResult,
  AgentScope,
  Context,
  ContextData,
  Item,
  StepAcpAgent,
} from '@noetic-tools/types';
import type { EmitOption } from '../runtime/broadcaster-utils';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import { errorMessage } from '../util/error-message';
import { isFunctionCall } from './typeguards';

/** A subagent's status, as the harness's agent events name it. */
type AgentStatus = 'running' | 'idle' | 'waiting' | 'unknown';

/** How a nested agent ended, as `agent_completed` says. */
type AgentEnd = 'completed' | 'failed' | 'cancelled';

/** One subagent of the turn, shown as a nested agent. */
interface ChildAgent {
  readonly scope: AgentScope;
  readonly bridge: AcpEventBridge;
  /** Why its work last stopped, when the agent said. */
  stopReason?: string;
}

/** The RFD's `state` and codex-acp's draft states, as agent statuses. */
const STATUS_OF: Readonly<Record<string, AgentStatus>> = {
  running: 'running',
  idle: 'idle',
  requires_action: 'waiting',
  unknown: 'unknown',
  completed: 'idle',
  failed: 'idle',
  cancelled: 'idle',
  disconnected: 'unknown',
};

/** How a subagent's last stop reason ends it. */
function endOf(stopReason: string | undefined): AgentEnd {
  if (stopReason === 'cancelled') {
    return 'cancelled';
  }
  if (stopReason === 'error' || stopReason === 'refusal' || stopReason === 'failed') {
    return 'failed';
  }
  return 'completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of an update, read without narrowing on its variant. */
function fieldOf(update: AcpChildUpdate['update'], name: string): string | undefined {
  const fields: Record<string, unknown> = {
    ...update,
  };
  const value = fields[name];
  return typeof value === 'string' ? value : undefined;
}

/** The state an announcement reports: the RFD's `state.state`, or the draft's `state`. */
function announcedState(update: AcpChildUpdate['update']): {
  status?: AgentStatus;
  stopReason?: string;
} {
  const fields: Record<string, unknown> = {
    ...update,
  };
  const state = fields.state;
  if (typeof state === 'string') {
    return {
      status: STATUS_OF[state],
      ...(state === 'completed' || state === 'failed' || state === 'cancelled'
        ? {
            stopReason: state,
          }
        : {}),
    };
  }
  if (!isRecord(state) || typeof state.state !== 'string') {
    return {};
  }
  return {
    status: STATUS_OF[state.state],
    ...(typeof state.stopReason === 'string'
      ? {
          stopReason: state.stopReason,
        }
      : {}),
  };
}

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
  /** Maps an agent's title for a bridged tool call to the tool's wire name. */
  private toolNameOf: (title: string) => string | undefined = () => undefined;
  /** The turn's subagents by child session id (spec 08 § Nested agents). */
  private readonly children = new Map<string, ChildAgent>();
  private readonly step: Pick<StepAcpAgent, 'id' | 'emit'>;
  private readonly ctx: Context<ContextData>;
  /** Prefix of the scope ids of this turn's subagents: the step's dispatch path. */
  private readonly scopeBase: string;

  constructor(
    step: Pick<StepAcpAgent, 'id' | 'emit'>,
    agentId: string,
    ctx: Context<ContextData>,
    /** The nested agent this bridge speaks for; absent for the step's own agent. */
    private readonly scope?: AgentScope,
  ) {
    this.broadcaster = getBroadcaster(ctx);
    this.agentName = ctx.harness.config.name;
    this.stepId = step.id;
    this.agentId = agentId;
    this.emitOption = step.emit;
    this.step = step;
    this.ctx = ctx;
    this.scopeBase =
      (ctx instanceof ContextImpl ? ctx.currentDispatch()?.path : undefined) ?? step.id;
  }

  /**
   * One update about a subagent: its announcement opens (or updates) a nested
   * agent; its own updates stream as that agent's output, scoped, never the
   * step's.
   */
  forwardChild(child: AcpChildUpdate): void {
    if (!this.broadcaster) {
      return;
    }
    const agent = this.children.get(child.sessionId) ?? this.openChild(child);
    if (!child.announcement) {
      agent.bridge.forward({
        sessionId: child.sessionId,
        update: child.update,
      });
      return;
    }
    const { status, stopReason } = announcedState(child.update);
    if (stopReason !== undefined) {
      agent.stopReason = stopReason;
    }
    if (status !== undefined) {
      agent.bridge.framework('agent_status', {
        status,
        ...(stopReason === undefined
          ? {}
          : {
              stopReason,
            }),
      });
    }
  }

  private openChild(child: AcpChildUpdate): ChildAgent {
    const parent = this.children.get(child.parentSessionId)?.scope.id ?? this.scope?.id;
    const title =
      (child.announcement
        ? (fieldOf(child.update, 'title') ?? fieldOf(child.update, 'name'))
        : undefined) ?? undefined;
    const scope: AgentScope = {
      id: `${this.scopeBase}/agent:${child.sessionId}`,
      ...(parent === undefined
        ? {}
        : {
            parentId: parent,
          }),
      ...(title === undefined
        ? {}
        : {
            title,
          }),
    };
    const agent: ChildAgent = {
      scope,
      bridge: new AcpEventBridge(this.step, this.agentId, this.ctx, scope),
    };
    this.children.set(child.sessionId, agent);
    agent.bridge.begin();
    const description = fieldOf(child.update, 'description') ?? fieldOf(child.update, 'task');
    agent.bridge.framework('agent_started', {
      ...(title === undefined
        ? {}
        : {
            title,
          }),
      ...(description === undefined
        ? {}
        : {
            description,
          }),
    });
    return agent;
  }

  /** The turn is over: every subagent's bracket closes, and it is reported ended. */
  private closeChildren(fallback: AgentEnd): void {
    for (const agent of this.children.values()) {
      const end = agent.stopReason === undefined ? fallback : endOf(agent.stopReason);
      agent.bridge.end(agent.stopReason ?? (end === 'completed' ? 'end_turn' : end));
      agent.bridge.framework('agent_completed', {
        status: end,
      });
    }
    this.children.clear();
  }

  /** Close this bracket without a turn result: a nested agent's work is over. */
  end(stopReason: string): void {
    if (!this.broadcaster || this.completed) {
      return;
    }
    this.closeMessage();
    this.start();
    this.sdk('response.completed', {
      stopReason,
    });
    this.completed = true;
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
    this.framework('acp_client_activity', {
      ...activity,
    });
  }

  /**
   * Name bridged tool calls by their wire name on the stream, as the
   * `callModel` stream names calls, rather than by the agent's display title.
   */
  nameToolCalls(nameOf: (title: string) => string | undefined): void {
    this.toolNameOf = nameOf;
  }

  /**
   * Treat these call ids as announced: each is a bridged call standing in the
   * turn's items where the agent's own record was, already on the stream
   * under the agent's id.
   */
  adoptToolCalls(callIds: ReadonlyArray<string>): void {
    for (const callId of callIds) {
      this.announcedToolCalls.add(callId);
    }
  }

  /**
   * Emit a bridged tool call's lifecycle event with the same payload the
   * `callModel` tool loop emits, filtered by the step's `emit` option.
   */
  toolEvent(eventType: string, data: Record<string, unknown>): void {
    if (!this.broadcaster || !shouldEmit(this.emitOption, eventType, data)) {
      return;
    }
    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType,
      data,
      scope: this.scope,
    });
  }

  /**
   * Broadcast a bridged tool's result item so `getItemStream` carries it.
   * Unfiltered, like the `callModel` path: item streaming is not subject to
   * `step.emit`.
   */
  itemAppended(item: Item): void {
    if (!this.broadcaster) {
      return;
    }
    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType: 'item_appended',
      scope: this.scope,
      data: {
        item,
      },
    });
  }

  /** Forward one notification: a structured framework event + the mapped sdk events. */
  forward(notification: AcpSessionNotification): void {
    if (!this.broadcaster) {
      return;
    }
    this.framework('acp_event', {
      sessionId: notification.sessionId,
      update: notification.update,
    });
    this.translate(notification.update);
  }

  /**
   * Forward one update `session/load` replayed: the loaded session's history,
   * not this turn's output. It reaches raw-event consumers as an `acp_event`
   * marked `replay: true` (same step, agent and session attribution) and is
   * never translated into text, reasoning or function-call events.
   */
  forwardReplay(notification: AcpSessionNotification): void {
    if (!this.broadcaster) {
      return;
    }
    this.framework('acp_event', {
      sessionId: notification.sessionId,
      update: notification.update,
      replay: true,
    });
  }

  /**
   * Ensure the turn's output reached the event surface. For an agent that
   * returns a result without streaming, synthesize events from the result.
   */
  finalize(result: AcpTurnResult): void {
    if (!this.broadcaster) {
      return;
    }
    this.closeChildren(result.stopReason === 'cancelled' ? 'cancelled' : 'completed');
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
    // Close the message before synthesizing tool calls, so output items finish
    // in index order. Emitting them first left item 0 closing after items 1..n,
    // which reads as interleaved output to a consumer tracking `outputIndex`.
    this.closeMessage();
    for (const item of result.items) {
      if (isFunctionCall(item) && !this.announcedToolCalls.has(item.callId)) {
        this.emitToolCall(item.callId, item.name, item.arguments);
      }
    }
    if (!this.completed) {
      this.start();
      this.sdk('response.completed', {
        stopReason: result.stopReason,
        ...(result.reportedUsage
          ? {
              reportedUsage: result.reportedUsage,
            }
          : {}),
      });
      this.completed = true;
    }
  }

  /**
   * Close a turn that failed. The bracket a consumer waits on must be honoured
   * even when the turn dies mid-stream, so an open message is closed and the
   * response completes with an error rather than the stream simply stopping.
   */
  abort(cause: unknown): void {
    if (!this.broadcaster || this.completed) {
      return;
    }
    this.closeChildren('cancelled');
    this.closeMessage();
    this.start();
    this.sdk('response.completed', {
      stopReason: 'error',
      error: errorMessage(cause),
    });
    this.completed = true;
  }

  //#region internals

  /**
   * Emit one framework event under this step's envelope. The `sdk` sibling
   * below does the same job for the model-stream surface; both gate on
   * `emitOption` so `emit: false` silences every surface at once.
   */
  framework(eventType: string, payload: Record<string, unknown>): void {
    if (!this.broadcaster) {
      return;
    }
    const data = {
      stepId: this.stepId,
      agentId: this.agentId,
      ...payload,
    };
    if (!shouldEmit(this.emitOption, eventType, data)) {
      return;
    }
    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType,
      data,
      scope: this.scope,
    });
  }

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
      ...(this.scope
        ? {
            scope: this.scope,
          }
        : {}),
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
      this.emitToolCall(
        update.toolCallId,
        this.toolNameOf(update.title) ?? update.title,
        update.rawInput,
      );
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
