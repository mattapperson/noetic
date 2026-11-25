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
  AcpChildInfo,
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
}

/** What a child last announced of its work. */
interface ChildStatus {
  status?: AgentStatus;
  /** Why its work last stopped, when the agent said. */
  stopReason?: string;
}

function statusData(status: ChildStatus): Record<string, unknown> {
  return {
    status: status.status,
    ...(status.stopReason === undefined
      ? {}
      : {
          stopReason: status.stopReason,
        }),
  };
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
  toolNameOf: (title: string) => string | undefined = () => undefined;
  /** The turn's subagents by child session id (spec 08 § Nested agents). */
  private readonly children = new Map<string, ChildAgent>();
  /** Set when the turn ended: no nested agent opens after that. */
  private childrenClosed = false;
  /** Each announced child and the subagents above it, as last announced. */
  private readonly lineages = new Map<string, ReadonlyArray<AcpChildInfo>>();
  /** Each announced child's status, shown once it is. */
  private readonly statuses = new Map<string, ChildStatus>();
  /** A nested agent's own tool calls by id, named as it announced them. */
  private readonly ownToolNames = new Map<string, string>();
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
    // One turn's subagents are not another's, even when a steering retry runs
    // the same dispatch path and the agent reuses a child session id.
    const path = (ctx instanceof ContextImpl ? ctx.currentDispatch()?.path : undefined) ?? step.id;
    this.scopeBase = `${path}/turn:${crypto.randomUUID().slice(0, 8)}`;
  }

  /**
   * One update about a subagent. Its announcement only registers it — what it
   * is and its status — so an announcement replayed for a child that does no
   * work this turn shows nothing. Its own updates open it, under its whole
   * parent chain, and stream as its output, scoped, never the step's.
   */
  forwardChild(child: AcpChildUpdate): void {
    // Once the turn is over its nested agents are closed: a late update opens
    // nothing it could never complete.
    if (!this.broadcaster || this.childrenClosed) {
      return;
    }
    this.lineages.set(child.sessionId, child.lineage);
    if (child.announcement) {
      this.noteStatus(child);
      return;
    }
    const agent = this.openChild(child.sessionId);
    agent?.bridge.forward({
      sessionId: child.sessionId,
      update: child.update,
    });
  }

  /**
   * The nested agent a request or a call from session `sessionId` belongs to,
   * opened if this turn has not shown it yet; undefined for the step's own
   * session or one never announced.
   */
  scopeFor(sessionId: string | undefined): AgentScope | undefined {
    if (sessionId === undefined) {
      return undefined;
    }
    const known = this.children.get(sessionId);
    if (known) {
      return known.scope;
    }
    if (this.childrenClosed) {
      return undefined;
    }
    return this.openChild(sessionId)?.scope;
  }

  /** Remember an announced status; tell it now if the nested agent is showing. */
  private noteStatus(child: AcpChildUpdate): void {
    const { status, stopReason } = announcedState(child.update);
    const previous = this.statuses.get(child.sessionId);
    // Running again clears an earlier stop: a recovered child does not end
    // with its old failure.
    const next: ChildStatus = {
      status: status ?? previous?.status,
      stopReason: status === 'running' ? undefined : (stopReason ?? previous?.stopReason),
    };
    this.statuses.set(child.sessionId, next);
    const agent = this.children.get(child.sessionId);
    if (agent && status !== undefined) {
      agent.bridge.framework('agent_status', statusData(next));
    }
  }

  /** Open `sessionId`'s nested agent, and every one above it first. */
  private openChild(sessionId: string): ChildAgent | undefined {
    const lineage = this.lineages.get(sessionId);
    if (!lineage || lineage.length === 0) {
      return undefined;
    }
    let parent: AgentScope | undefined = this.scope;
    let agent: ChildAgent | undefined;
    for (const info of lineage) {
      agent = this.children.get(info.sessionId) ?? this.startChild(info, parent);
      parent = agent.scope;
    }
    return agent;
  }

  private startChild(info: AcpChildInfo, parent: AgentScope | undefined): ChildAgent {
    const scope: AgentScope = {
      id: `${this.scopeBase}/agent:${info.sessionId}`,
      ...(parent === undefined
        ? {}
        : {
            parentId: parent.id,
          }),
      ...(info.title === undefined
        ? {}
        : {
            title: info.title,
          }),
    };
    const agent: ChildAgent = {
      scope,
      bridge: new AcpEventBridge(this.step, this.agentId, this.ctx, scope),
    };
    agent.bridge.toolNameOf = this.toolNameOf;
    this.children.set(info.sessionId, agent);
    agent.bridge.begin();
    agent.bridge.framework('agent_started', {
      ...(info.title === undefined
        ? {}
        : {
            title: info.title,
          }),
      ...(info.description === undefined
        ? {}
        : {
            description: info.description,
          }),
    });
    const status = this.statuses.get(info.sessionId);
    if (status?.status !== undefined) {
      agent.bridge.framework('agent_status', statusData(status));
    }
    return agent;
  }

  /** The turn is over: every subagent's bracket closes, and it is reported ended. */
  private closeChildren(fallback: AgentEnd): void {
    this.childrenClosed = true;
    for (const [sessionId, agent] of this.children) {
      const stopReason = this.statuses.get(sessionId)?.stopReason;
      const end = stopReason === undefined ? fallback : endOf(stopReason);
      agent.bridge.end(stopReason ?? (end === 'completed' ? 'end_turn' : end));
      agent.bridge.framework('agent_completed', {
        status: end,
      });
    }
    // Kept, closed: a call or an audit record that arrives late is still its own.
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
    // A subagent's own file and terminal calls are its nested agent's.
    const scope = this.scopeFor(activity.sessionId);
    const child =
      scope && activity.sessionId !== undefined ? this.children.get(activity.sessionId) : undefined;
    if (child) {
      child.bridge.forwardActivity(activity);
      return;
    }
    this.framework('acp_client_activity', {
      ...activity,
    });
  }

  /** The event bridge of the subagent in child session `sessionId`, when the turn has one. */
  childBridge(sessionId: string): AcpEventBridge | undefined {
    return this.children.get(sessionId)?.bridge;
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

  /**
   * A nested agent's tool call that finished, as the generic tool event: its
   * own tools are not bridged, so nothing else reports it.
   */
  private childToolSettled(
    update: Extract<
      SessionUpdate,
      {
        sessionUpdate: 'tool_call_update';
      }
    >,
  ): void {
    if (update.status !== 'completed' && update.status !== 'failed') {
      return;
    }
    // Not one of its own announced calls: a bridged one, reported by the bridge.
    if (!this.ownToolNames.has(update.toolCallId)) {
      return;
    }
    this.framework('tool_call_completed', {
      name: this.ownToolNames.get(update.toolCallId) ?? update.title ?? update.toolCallId,
      callId: update.toolCallId,
      error: update.status === 'failed',
    });
    this.ownToolNames.delete(update.toolCallId);
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
    // A nested agent is named by its scope alone; the adapter's id is the step's.
    const data = this.scope
      ? {
          stepId: this.stepId,
          ...payload,
        }
      : {
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
    // A nested agent's own tools have no other reporter; a call to one of the
    // step's bridged tools is reported by the bridge, once.
    if (this.scope && update.sessionUpdate === 'tool_call' && !this.toolNameOf(update.title)) {
      this.ownToolNames.set(update.toolCallId, update.title);
      this.framework('tool_call_started', {
        name: update.title,
        callId: update.toolCallId,
      });
    }
    if (this.scope && update.sessionUpdate === 'tool_call_update') {
      this.childToolSettled(update);
    }
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
