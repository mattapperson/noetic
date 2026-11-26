/**
 * Maps an ACP turn's `session/update` notifications onto the harness's
 * observable event surface.
 *
 * A coding agent's text, reasoning, and tool calls are translated into the same
 * events the model-call path emits, so they flow through `getTextStream()` /
 * `getReasoningStream()` / `getItemStream()` / `getFullStream()` exactly like an
 * LLM step's output. Nothing on the stream names the protocol: a call's
 * presentation, progress and structured content, the agent's plan and its
 * mode and model reach the host in the harness's own activity vocabulary
 * (`acp-activity`); the rest of the session's state (commands, context
 * occupancy) is tracked on the live session, never emitted.
 *
 * `finalize()` guarantees a turn always emits its output: if an agent returns a
 * stop reason without streaming any text or tool calls, the result's content is
 * synthesized into events.
 */

import type {
  AcpChildInfo,
  AcpChildUpdate,
  AcpClientActivity,
  AcpClientMethod,
  AcpSessionNotification,
  AcpTurnResult,
  AgentScope,
  Context,
  ContextData,
  FunctionCallItem,
  FunctionCallOutputItem,
  Item,
  StepAcpAgent,
  ToolCallPresentation,
  ToolContent,
  ToolIdentity,
} from '@noetic-tools/types';
import { frameworkCast, toolIdentityData } from '@noetic-tools/types';
import type { EmitOption } from '../runtime/broadcaster-utils';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import { ContextImpl } from '../runtime/context-impl';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import { errorMessage } from '../util/error-message';
import type { ToolCallUpdate } from './acp-activity';
import {
  contentText,
  dataUrl,
  modelOf,
  planOf,
  presentationOf,
  progressOf,
  progressReport,
  toolContentOf,
} from './acp-activity';
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

/** The output of a call the agent never reported finished before its turn ended. */
const UNFINISHED_OUTPUT = 'The agent ended its turn before this call finished.';

/** The output of a call to one of the step's tools that never reached the tool. */
const NEVER_RAN_OUTPUT = 'The call never reached the tool.';

/**
 * One of the turn's tool calls, by the id its item and its lifecycle carry.
 * The agent reports its own calls; the step's tool bridge reports calls to the
 * step's tools, once it runs them.
 */
interface TurnCall {
  readonly name: string;
  /** Which tool it is to: its `toolId` and `toolServer` on every event of it. */
  readonly identity: ToolIdentity;
  readonly via: 'own' | 'bridged';
  /** The stream that carries it: the step's, or a nested agent's. */
  readonly bridge: AcpEventBridge;
  /**
   * `announced`: an agent named a call to one of the step's tools, and the
   * bridge has not run it yet. `open`: started, not completed. `closed`: done.
   */
  state: 'announced' | 'open' | 'closed';
  /** What the announcement gave as the call's input. */
  readonly input?: unknown;
  /** How the announcement presented the call. */
  readonly presentation?: ToolCallPresentation;
  /** What the call has produced so far: the agent's latest content for it. */
  content?: ToolContent[];
}

/** Every tool call of one turn, shared by the step's agent and its nested agents. */
class TurnCalls {
  readonly byId = new Map<string, TurnCall>();
  /** Calls the bridge ran under an id no announcement had, in order: tool and input. */
  readonly unannounced: Array<{
    readonly name: string;
    readonly input: string;
  }> = [];
}

/** A call's input as a comparable key. */
function inputKey(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  return JSON.stringify(input ?? {});
}

/** What a step did through the host's fs or shell adapters, as `workspace_access` names it. */
const OPERATION_OF: Readonly<Record<AcpClientMethod, string>> = {
  'fs/read_text_file': 'read_file',
  'fs/write_text_file': 'write_file',
  'terminal/create': 'run_command',
  'terminal/output': 'read_output',
  'terminal/wait_for_exit': 'wait',
  'terminal/kill': 'kill',
  'terminal/release': 'release',
};

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
  private readonly emitOption: EmitOption | undefined;
  private started = false;
  private completed = false;
  private nextOutputIndex = 0;
  private messageOutputIndex: number | null = null;
  /** The open message's id and its text so far. */
  private messageId = '';
  private messageText = '';
  private sawText = false;
  /** The model the agent last reported, so a change is told once. */
  private model: string | undefined;
  /** Maps an agent's title for a bridged tool call to the tool's wire name. */
  toolNameOf: (title: string) => string | undefined = () => undefined;
  /** Which tool a call to one of the step's tools is to, from its wire name and input. */
  bridgedIdentityOf: (wireName: string, input: unknown) => ToolIdentity = (wireName) => ({
    id: wireName,
  });
  /** Which of the agent's own tools a call is to, as its adapter reads it. */
  toolIdOf: (update: ToolCallUpdate) => ToolIdentity | undefined = () => undefined;
  /** The turn's subagents by child session id (spec 08 § Nested agents). */
  private readonly children = new Map<string, ChildAgent>();
  /** Set when the turn ended: no nested agent opens after that. */
  private childrenClosed = false;
  /** Each announced child and the subagents above it, as last announced. */
  private readonly lineages = new Map<string, ReadonlyArray<AcpChildInfo>>();
  /** Each announced child's status, shown once it is. */
  private readonly statuses = new Map<string, ChildStatus>();
  private readonly step: Pick<StepAcpAgent, 'id' | 'emit'>;
  private readonly ctx: Context<ContextData>;
  /** Prefix of the scope ids of this turn's subagents: the step's dispatch path. */
  private readonly scopeBase: string;

  constructor(
    step: Pick<StepAcpAgent, 'id' | 'emit'>,
    ctx: Context<ContextData>,
    /** The nested agent this bridge speaks for; absent for the step's own agent. */
    private readonly scope?: AgentScope,
    /** The turn's tool calls, shared with the bridge of the agent that started this one. */
    private readonly calls: TurnCalls = new TurnCalls(),
  ) {
    this.broadcaster = getBroadcaster(ctx);
    this.agentName = ctx.harness.config.name;
    this.stepId = step.id;
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
      bridge: new AcpEventBridge(this.step, this.ctx, scope, this.calls),
    };
    agent.bridge.toolNameOf = this.toolNameOf;
    agent.bridge.toolIdOf = this.toolIdOf;
    agent.bridge.bridgedIdentityOf = this.bridgedIdentityOf;
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
    this.settleOpenCalls();
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
    const { method, sessionId: _session, ...access } = activity;
    this.framework('workspace_access', {
      operation: OPERATION_OF[method],
      ...access,
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
  nameToolCalls(
    nameOf: (title: string) => string | undefined,
    identityOf?: (wireName: string, input: unknown) => ToolIdentity,
  ): void {
    this.toolNameOf = nameOf;
    if (identityOf) {
      this.bridgedIdentityOf = identityOf;
    }
  }

  /**
   * Identify the agent's own calls by the tool they are to, as its adapter
   * reads it from the agent's update; a call it cannot place goes by its title.
   */
  identifyToolCalls(
    identify: ((update: ToolCallUpdate) => ToolIdentity | undefined) | undefined,
  ): void {
    if (identify) {
      this.toolIdOf = identify;
    }
  }

  /**
   * Which tool an announced call of the agent's own is to: as its adapter
   * reads it; else its kind, so calls an agent names by title alone ("Run
   * ls", "Run pwd") still group as one tool; else, with no kind to go by, its
   * title.
   */
  private identityOf(update: ToolCallUpdate): ToolIdentity {
    let read: ToolIdentity | undefined;
    try {
      read = this.toolIdOf(update);
    } catch {
      read = undefined;
    }
    if (read) {
      return read;
    }
    const kind = update.kind ?? undefined;
    return {
      id: kind !== undefined && kind !== 'other' ? kind : (update.title ?? update.toolCallId),
    };
  }

  /**
   * The tool bridge is running a call to one of the step's tools: its item —
   * with the arguments it runs with — then `tool_call_started`, under the id
   * the bridge runs it under. An announcement of the same id is this call.
   */
  bridgedCallStarted(
    callId: string,
    name: string,
    args: unknown,
    presentation: ToolCallPresentation = {},
    identity: ToolIdentity = {
      id: name,
    },
  ): void {
    const announced = this.calls.byId.get(callId);
    if (announced?.state !== 'announced') {
      this.calls.unannounced.push({
        name,
        input: inputKey(args),
      });
    }
    this.calls.byId.set(callId, {
      name,
      identity,
      via: 'bridged',
      bridge: this,
      state: 'open',
    });
    this.closeMessage();
    this.emitToolCall(callId, name, args ?? announced?.input);
    // As the tool presents itself, exactly as in a `callModel` step: never by
    // the agent's own name for the call.
    this.toolEvent('tool_call_started', {
      name,
      callId,
      ...presentation,
    });
  }

  /** The tool bridge finished a call: its `tool_call_completed`. */
  bridgedCallCompleted(callId: string, data: Record<string, unknown>): void {
    const call = this.calls.byId.get(callId);
    if (call) {
      call.state = 'closed';
    }
    this.toolEvent('tool_call_completed', {
      ...data,
      callId,
    });
  }

  /**
   * Emit a bridged tool call's lifecycle event with the same payload the
   * `callModel` tool loop emits, filtered by the step's `emit` option.
   */
  toolEvent(eventType: string, data: Record<string, unknown>): void {
    // Every event of a call names the tool it is to (spec 08 § Tool calls).
    const call = typeof data.callId === 'string' ? this.calls.byId.get(data.callId) : undefined;
    const payload = call
      ? {
          ...data,
          ...toolIdentityData(call.identity),
        }
      : data;
    if (!this.broadcaster || !shouldEmit(this.emitOption, eventType, payload)) {
      return;
    }
    emitFrameworkEvent({
      broadcaster: this.broadcaster,
      agentName: this.agentName,
      eventType,
      data: payload,
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

  /** Forward one notification of the turn as the events a model call emits. */
  forward(notification: AcpSessionNotification): void {
    if (!this.broadcaster) {
      return;
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
    this.settleUnstartedCalls();
    this.closeChildren(result.stopReason === 'cancelled' ? 'cancelled' : 'completed');
    if (!this.sawText && result.text.length > 0) {
      this.messageDelta(result.text);
    }
    // Close the message before synthesizing tool calls, so output items finish
    // in index order. Emitting them first left item 0 closing after items 1..n,
    // which reads as interleaved output to a consumer tracking `outputIndex`.
    this.closeMessage();
    for (const item of result.items) {
      if (isFunctionCall(item) && !this.calls.byId.has(item.callId)) {
        this.synthesizeToolCall(item, result.items);
      }
    }
    this.settleOpenCalls();
    if (!this.completed) {
      this.start();
      this.sdk('response.completed', {
        stopReason: result.stopReason,
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
    this.settleUnstartedCalls();
    this.closeChildren('cancelled');
    this.closeMessage();
    this.settleOpenCalls();
    this.start();
    this.sdk('response.completed', {
      stopReason: 'error',
      error: errorMessage(cause),
    });
    this.completed = true;
  }

  /**
   * One update about one of the agent's own tool calls, as the generic tool
   * events: its own tools are not bridged, so nothing else reports them. A
   * running call's changes are `tool_progress`; a finished one is
   * `tool_call_completed`, carrying everything it produced as structure.
   * `announced`: the update is the call's announcement, whose presentation
   * and status `tool_call_started` already carried.
   */
  private ownToolUpdated(update: ToolCallUpdate, announced: boolean): void {
    const call = this.calls.byId.get(update.toolCallId);
    // Only an own call still open: a bridged one is the bridge's to report.
    if (call?.via !== 'own' || call.state !== 'open') {
      return;
    }
    if (update.content) {
      call.content = toolContentOf(update.content);
    }
    const final = update.status === 'completed' || update.status === 'failed';
    this.reportOwnProgress(update, call, {
      announced,
      final,
    });
    if (!final) {
      return;
    }
    call.state = 'closed';
    const content = call.content ?? [];
    const output = contentText(content);
    this.toolEvent('tool_call_completed', {
      name: call.name,
      callId: update.toolCallId,
      error: update.status === 'failed',
      ...(output === undefined
        ? {}
        : {
            output,
          }),
      ...(content.length > 0
        ? {
            content,
          }
        : {}),
      ...(update.rawOutput === undefined || update.rawOutput === null
        ? {}
        : {
            result: update.rawOutput,
          }),
    });
  }

  /**
   * A running own call's `tool_progress`: what this update changed. An
   * announcement reports only what `tool_call_started` did not carry (its
   * content, its progress); a final update leaves its content to the
   * completion.
   */
  private reportOwnProgress(
    update: ToolCallUpdate,
    call: TurnCall,
    at: {
      announced: boolean;
      final: boolean;
    },
  ): void {
    const report = at.announced
      ? {
          ...(update.content && !at.final
            ? {
                content: call.content,
              }
            : {}),
          ...(progressOf(update) === undefined
            ? {}
            : {
                progress: progressOf(update),
              }),
        }
      : progressReport(update, at.final ? undefined : (update.status ?? undefined));
    if (!report) {
      return;
    }
    const { content, ...changes } = report;
    const data = at.final || content === undefined ? changes : report;
    if (Object.keys(data).length === 0) {
      return;
    }
    this.toolEvent('tool_progress', {
      name: call.name,
      callId: update.toolCallId,
      ...data,
    });
  }

  /**
   * The turn is over: a call started on this stream and never reported
   * finished — the agent's own, or one whose pipeline threw — is settled
   * failed, so no consumer is left with a call that started and never ended.
   */
  private settleOpenCalls(): void {
    for (const [callId, call] of this.calls.byId) {
      if (call.bridge !== this || call.state !== 'open') {
        continue;
      }
      call.state = 'closed';
      this.toolEvent('tool_call_completed', {
        name: call.name,
        callId,
        error: true,
        output: UNFINISHED_OUTPUT,
      });
    }
  }

  /**
   * The turn is over: a call an agent announced to one of the step's tools
   * that the bridge never ran under that id either ran under another (the
   * bridge ran that tool under an id no announcement had) or never ran at all,
   * which is reported as a failed call on the announcing agent's stream.
   */
  private settleUnstartedCalls(): void {
    const left: Array<
      [
        string,
        TurnCall,
      ]
    > = [];
    const runs = [
      ...this.calls.unannounced,
    ];
    // The same tool with the same input first: that is the call, run under another id.
    for (const [callId, call] of this.calls.byId) {
      if (call.state !== 'announced') {
        continue;
      }
      call.state = 'closed';
      const at = runs.findIndex(
        (run) => run.name === call.name && run.input === inputKey(call.input),
      );
      if (at >= 0) {
        runs.splice(at, 1);
        continue;
      }
      left.push([
        callId,
        call,
      ]);
    }
    // Then by tool alone. With no run of the tool left, none of them ran; with
    // as many runs as announcements, all did; with fewer, which ones did is
    // unknown, so none is reported failed on a guess.
    for (const name of new Set(left.map(([, call]) => call.name))) {
      const unmatched = runs.filter((run) => run.name === name).length;
      if (unmatched > 0) {
        continue;
      }
      for (const [callId, call] of left) {
        if (call.name === name) {
          call.bridge.reportUnran(callId, call);
        }
      }
    }
  }

  private reportUnran(callId: string, call: TurnCall): void {
    this.closeMessage();
    this.emitToolCall(callId, call.name, call.input);
    this.toolEvent('tool_call_started', {
      name: call.name,
      callId,
      ...call.presentation,
    });
    this.toolEvent('tool_call_completed', {
      name: call.name,
      callId,
      error: true,
      output: NEVER_RAN_OUTPUT,
    });
  }

  /**
   * A call the agent reported only in its result: its item, then the
   * lifecycle the stream never saw, with the output the result recorded.
   */
  private synthesizeToolCall(item: FunctionCallItem, items: ReadonlyArray<Item>): void {
    // Identified as its announcement would have been: by the agent's reader,
    // else its kind, else its title.
    const kind = frameworkCast<{
      acpToolKind?: ToolCallUpdate['kind'];
    }>(item).acpToolKind;
    this.calls.byId.set(item.callId, {
      name: item.name,
      identity: this.identityOf({
        sessionUpdate: 'tool_call',
        toolCallId: item.callId,
        title: item.name,
        ...(kind
          ? {
              kind,
            }
          : {}),
      }),
      via: 'own',
      bridge: this,
      state: 'closed',
    });
    this.emitToolCall(item.callId, item.name, item.arguments);
    const output = items.find(
      (candidate): candidate is FunctionCallOutputItem =>
        candidate.type === 'function_call_output' && candidate.callId === item.callId,
    );
    this.toolEvent('tool_call_started', {
      name: item.name,
      callId: item.callId,
    });
    // As its result recorded it: a call with no result never finished.
    this.toolEvent('tool_call_completed', {
      name: item.name,
      callId: item.callId,
      error: output === undefined || output.status === 'failed' || output.status === 'incomplete',
      output: output?.output ?? UNFINISHED_OUTPUT,
    });
  }

  /**
   * One update announcing a tool call. The agent's own call is its item, then
   * `tool_call_started`, as the `callModel` tool loop reports one; a call to
   * one of the step's tools waits for the bridge to run it. An id already
   * known is the same call again.
   */
  private toolCallAnnounced(
    update: ToolCallUpdate & {
      sessionUpdate: 'tool_call';
    },
  ): void {
    const callId = update.toolCallId;
    if (this.calls.byId.has(callId)) {
      return;
    }
    const presentation = presentationOf(update);
    const wireName = this.toolNameOf(update.title);
    if (wireName) {
      this.calls.byId.set(callId, {
        name: wireName,
        identity: this.bridgedIdentityOf(wireName, update.rawInput),
        via: 'bridged',
        bridge: this,
        state: 'announced',
        input: update.rawInput,
        presentation,
      });
      return;
    }
    this.calls.byId.set(callId, {
      name: update.title,
      identity: this.identityOf(update),
      via: 'own',
      bridge: this,
      state: 'open',
    });
    this.closeMessage();
    this.emitToolCall(callId, update.title, update.rawInput);
    const status =
      update.status === 'pending' || update.status === 'in_progress' ? update.status : undefined;
    this.toolEvent('tool_call_started', {
      name: update.title,
      callId,
      ...presentation,
      ...(status === undefined
        ? {}
        : {
            status,
          }),
    });
    // Content it came with, and a call reported already finished, at once.
    this.ownToolUpdated(update, true);
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
    // Named by its step (and a nested agent by its scope): which adapter runs
    // the agent is the workflow's business, not the host's.
    const data = {
      stepId: this.stepId,
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

  /** Stream text into the open assistant message, opening one first if none is. */
  private messageDelta(delta: string): void {
    this.openMessage();
    this.messageText += delta;
    this.sdk(
      'response.output_text.delta',
      {
        delta,
      },
      this.messageOutputIndex ?? 0,
    );
    this.sawText = true;
  }

  private openMessage(): void {
    if (this.messageOutputIndex !== null) {
      return;
    }
    this.start();
    const id = `acp-msg-${crypto.randomUUID()}`;
    this.messageId = id;
    this.messageText = '';
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
    // The finished message, as a model's stream ends one.
    this.sdk(
      'response.output_text.done',
      {
        text: this.messageText,
      },
      index,
    );
    this.sdk(
      'response.output_item.done',
      {
        item: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: this.messageText,
            },
          ],
        },
      },
      index,
    );
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
    // The finished call item, as a model's stream ends one: what a consumer
    // reads the call's arguments from.
    this.sdk(
      'response.output_item.done',
      {
        item: {
          id: toolCallId,
          type: 'function_call',
          status: 'completed',
          callId: toolCallId,
          name,
          arguments: args,
        },
      },
      index,
    );
  }

  private translate(update: SessionUpdate): void {
    if (update.sessionUpdate === 'tool_call_update') {
      this.ownToolUpdated(update, false);
      return;
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.messageChunk(update.content);
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
      this.toolCallAnnounced(update);
      return;
    }
    this.sessionState(update);
  }

  /**
   * An update about the session rather than its output: the agent's plan, its
   * mode and its model reach the host as generic events; everything else
   * (commands, context occupancy, replayed history) is not shown.
   */
  private sessionState(update: SessionUpdate): void {
    if (update.sessionUpdate === 'plan' || update.sessionUpdate === 'plan_update') {
      this.framework('plan_updated', {
        plan: planOf(update),
      });
      return;
    }
    if (update.sessionUpdate === 'plan_removed') {
      this.framework(
        'plan_removed',
        update.planId
          ? {
              id: update.planId,
            }
          : {},
      );
      return;
    }
    if (update.sessionUpdate === 'current_mode_update') {
      this.framework('agent_config_updated', {
        mode: update.currentModeId,
      });
      return;
    }
    if (update.sessionUpdate !== 'config_option_update') {
      return;
    }
    const model = modelOf(update.configOptions);
    if (model === undefined || model === this.model) {
      return;
    }
    this.model = model;
    this.framework('agent_config_updated', {
      model,
    });
  }

  /**
   * One chunk of the agent's message. An image is an image output item, as a
   * model's generated image is — never text; everything else is text.
   */
  private messageChunk(content: Parameters<typeof blockText>[0]): void {
    if (content.type !== 'image') {
      this.messageDelta(blockText(content));
      return;
    }
    this.closeMessage();
    this.start();
    const index = this.nextOutputIndex++;
    const item = {
      id: `acp-img-${crypto.randomUUID()}`,
      type: 'image_generation_call',
      status: 'completed',
      // A data URL, so the image carries its media type.
      result: dataUrl(content.mimeType, content.data),
    };
    this.sdk(
      'response.output_item.added',
      {
        item,
      },
      index,
    );
    this.sdk(
      'response.output_item.done',
      {
        item,
      },
      index,
    );
  }

  //#endregion
}
