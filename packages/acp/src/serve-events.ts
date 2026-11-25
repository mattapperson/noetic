/**
 * Turn translation for the server direction: the client-direction event
 * bridge's table (spec 27, "Output → harness events") run backwards. One pump
 * consumes the harness's full event stream for a single prompt turn and emits
 * `session/update` notifications until the turn boundary resolves the
 * `session/prompt` request with a stop reason.
 */

import type {
  AcpSessionNotification,
  AcpStopReason,
  AcpToolCallContent,
  StreamEvent,
  ToolContent,
  ToolLocation,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';

//#region Types

/** One `session/update` payload. */
export type ServeSessionUpdate = AcpSessionNotification['update'];

/** How a tool call is presented on the wire. */
export interface ServeToolCallPresentation {
  title: string;
  kind?: ServeToolCallKind;
  locations?: Array<{
    path: string;
    line?: number;
  }>;
  /** Initial status: `pending` when the policy will ask, `in_progress` otherwise. */
  status: 'pending' | 'in_progress';
}

type ServeToolCallKind = Extract<
  ServeSessionUpdate,
  {
    sessionUpdate: 'tool_call';
  }
>['kind'];

/** @public How a served prompt turn ended. */
export type ServeTurnOutcome =
  | {
      kind: 'stop';
      stopReason: AcpStopReason;
    }
  | {
      kind: 'error';
      message: string;
    };

export interface PumpTurnParams {
  events: AsyncIterable<StreamEvent>;
  /** The id passed to `execute()`; claims the turn in `turn_started.messageIds`. */
  messageId: string;
  /** Send one notification to the client. */
  notify(update: ServeSessionUpdate): Promise<void>;
  /** Resolve presentation for a first-party tool call. */
  present(toolName: string, callId: string, args: unknown): ServeToolCallPresentation;
  /** Whether `session/cancel` was received for this session. */
  cancelRequested(): boolean;
  /** Sees every event of the turn as it is pumped. */
  observe?: (event: StreamEvent) => void;
}

//#endregion

//#region Claim helpers (same suffix-matching rules as chat-sdk's translator)

function hasEventName(event: StreamEvent, name: string): boolean {
  return event.source === 'framework' && event.type.endsWith(`:${name}`);
}

type TurnClaim =
  | {
      kind: 'ours';
      turnId: string | null;
      primary: boolean;
    }
  | {
      kind: 'none';
    };

function matchClaim(event: StreamEvent, messageId: string): TurnClaim {
  if (!hasEventName(event, 'turn_started') && !hasEventName(event, 'inbox_injected')) {
    return {
      kind: 'none',
    };
  }
  const ids = event.data.messageIds;
  if (!Array.isArray(ids) || !ids.includes(messageId)) {
    return {
      kind: 'none',
    };
  }
  return {
    kind: 'ours',
    turnId: typeof event.data.turnId === 'string' ? event.data.turnId : null,
    // When queued prompts coalesce into one turn, only the FIRST id's pump
    // sends notifications — the others resolve silently at the same boundary,
    // so the client never sees the turn twice.
    primary: ids[0] === messageId,
  };
}

function matchesTurn(event: StreamEvent, turnId: string | null): boolean {
  return turnId === null || event.data.turnId === turnId;
}

//#endregion

//#region Event readers

function readToolCall(event: StreamEvent): {
  name: string;
  callId: string;
} | null {
  const { name, callId } = event.data;
  if (typeof name !== 'string' || typeof callId !== 'string') {
    return null;
  }
  return {
    name,
    callId,
  };
}

const KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const;

/** How a call presents, as its events carry it (spec 08 § Tool calls, plans and agent settings). */
const EventPresentationSchema = z.object({
  title: z.string().optional(),
  kind: z.enum(KINDS).optional(),
  locations: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().optional(),
      }),
    )
    .optional(),
  status: z
    .enum([
      'pending',
      'in_progress',
    ])
    .optional(),
  progress: z.number().optional(),
});

type EventPresentation = z.infer<typeof EventPresentationSchema>;

function readPresentation(event: StreamEvent): EventPresentation {
  const parsed = EventPresentationSchema.safeParse(event.data);
  return parsed.success ? parsed.data : {};
}

/** A call's structured content, as its events carry it; undefined when it carries none. */
function readContent(event: StreamEvent): ToolContent[] | undefined {
  const content = event.data.content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  return frameworkCast<ToolContent[]>(content);
}

function wireLocations(
  locations: ReadonlyArray<ToolLocation> | undefined,
): ServeToolCallPresentation['locations'] {
  return locations?.map((location) => ({
    path: location.path,
    ...(location.line === undefined
      ? {}
      : {
          line: location.line,
        }),
  }));
}

/** A content block of a tool call's wire content. */
type WireBlock = Extract<
  AcpToolCallContent,
  {
    type: 'content';
  }
>['content'];

type ContentOf<T extends ToolContent['type']> = Extract<
  ToolContent,
  {
    type: T;
  }
>;

/** Each content part that is a block on the wire, by its type. */
type BlockMappers = {
  [T in Exclude<ToolContent['type'], 'diff' | 'terminal'>]: (content: ContentOf<T>) => WireBlock;
};

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** Media carried as a data URL, as the wire's own media block; undefined for a plain URL. */
function mediaBlock(kind: 'image' | 'audio', url: string): WireBlock | undefined {
  const match = DATA_URL.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    return undefined;
  }
  return {
    type: kind,
    mimeType: match[1],
    data: match[2],
  };
}

/** Something that lives at a URL: a link to it. */
function linkBlock(uri: string, name?: string): WireBlock {
  return {
    type: 'resource_link',
    uri,
    name: name ?? uri.split('/').pop() ?? uri,
  };
}

function fileBlock(content: ContentOf<'input_file'>): WireBlock {
  const media = content.fileData ? DATA_URL.exec(content.fileData) : null;
  if (media?.[1]?.startsWith('audio/') && media[2] !== undefined) {
    return {
      type: 'audio',
      mimeType: media[1],
      data: media[2],
    };
  }
  const name = content.filename ?? 'file';
  if (media?.[1] && media[2] !== undefined) {
    return {
      type: 'resource',
      resource: {
        uri: name,
        mimeType: media[1],
        blob: media[2],
      },
    };
  }
  return linkBlock(content.fileUrl ?? content.fileId ?? name, name);
}

/** A video: the wire has no video block, so its bytes as a resource, or a link to it. */
function videoBlock(url: string): WireBlock {
  const media = DATA_URL.exec(url);
  if (media?.[1] && media[2] !== undefined) {
    return {
      type: 'resource',
      resource: {
        uri: 'video',
        mimeType: media[1],
        blob: media[2],
      },
    };
  }
  return linkBlock(url);
}

const BLOCKS: BlockMappers = {
  input_text: (content) => ({
    type: 'text',
    text: content.text,
  }),
  input_image: (content) => mediaBlock('image', content.imageUrl) ?? linkBlock(content.imageUrl),
  input_file: fileBlock,
  input_video: (content) => videoBlock(content.videoUrl),
  resource_link: (content) => content,
  resource: ({ uri, mimeType, text, blob }) => ({
    type: 'resource',
    resource:
      text === undefined
        ? {
            uri,
            mimeType,
            blob: blob ?? '',
          }
        : {
            uri,
            mimeType,
            text,
          },
  }),
};

/** One piece of structured content, as the wire's tool-call content. */
function wireContent(content: ToolContent): AcpToolCallContent {
  if (content.type === 'diff' || content.type === 'terminal') {
    return content;
  }
  // The registry is keyed by the union's own tags, so its mapper takes this part.
  const toBlock = frameworkCast<(part: ToolContent) => WireBlock>(BLOCKS[content.type]);
  return {
    type: 'content',
    content: toBlock(content),
  };
}

/**
 * Capture parsed args from the model's completed function_call item so
 * presentation (title functions, locations) can see them; emitted before the
 * tool round runs, so it always precedes the matching `tool_call_started`.
 */
function readFunctionCallArgs(event: StreamEvent): {
  callId: string;
  args: unknown;
} | null {
  if (event.type !== 'response.output_item.done') {
    return null;
  }
  const item = event.data.item;
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = frameworkCast<Record<string, unknown>>(item);
  if (record.type !== 'function_call' || typeof record.callId !== 'string') {
    return null;
  }
  let args: unknown;
  if (typeof record.arguments === 'string') {
    try {
      args = JSON.parse(record.arguments);
    } catch {
      args = record.arguments;
    }
  }
  return {
    callId: record.callId,
    args,
  };
}

//#endregion

//#region Pump

/**
 * Consume the harness event stream for one prompt turn, translating to
 * `session/update` notifications, and return how the turn ended.
 */
export async function pumpTurnEvents(params: PumpTurnParams): Promise<ServeTurnOutcome> {
  const state: TurnState = {
    params,
    primary: false,
    turnId: null,
    argsByCallId: new Map<string, unknown>(),
    openCalls: new Set<string>(),
  };
  let claimed = false;

  for await (const event of params.events) {
    if (!claimed) {
      const claim = matchClaim(event, params.messageId);
      if (claim.kind === 'ours') {
        claimed = true;
        state.primary = claim.primary;
        state.turnId = claim.turnId;
      }
      continue;
    }
    params.observe?.(event);
    // A nested agent's events are not the session's turn: the editor sees the
    // agent's own answer, as getTextStream does (spec 08 § Nested agents).
    if (event.scope) {
      continue;
    }
    if (event.source === 'sdk') {
      await handleSdkEvent(state, event);
      continue;
    }
    const outcome = await handleFrameworkEvent(state, event);
    if (outcome) {
      return outcome;
    }
  }

  // The stream ended without a boundary — the harness (or connection) is
  // shutting down. Cancelled is the honest stop reason: the turn did not
  // complete and no error was reported.
  return {
    kind: 'stop',
    stopReason: 'cancelled',
  };
}

interface TurnState {
  params: PumpTurnParams;
  primary: boolean;
  turnId: string | null;
  argsByCallId: Map<string, unknown>;
  /** Calls started but not completed — flushed at the turn boundary so the client is never left with a spinner. */
  openCalls: Set<string>;
}

async function flushOpenCalls(state: TurnState, status: 'completed' | 'failed'): Promise<void> {
  for (const toolCallId of state.openCalls) {
    await notifyIfPrimary(state.params, state.primary, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status,
    });
  }
  state.openCalls.clear();
}

async function handleSdkEvent(state: TurnState, event: StreamEvent): Promise<void> {
  const { params, primary } = state;
  if (event.type === 'response.output_text.delta' && typeof event.data.delta === 'string') {
    await notifyIfPrimary(params, primary, textChunk('agent_message_chunk', event.data.delta));
    return;
  }
  if (event.type === 'response.reasoning.delta' && typeof event.data.delta === 'string') {
    await notifyIfPrimary(params, primary, textChunk('agent_thought_chunk', event.data.delta));
    return;
  }
  const fc = readFunctionCallArgs(event);
  if (fc) {
    state.argsByCallId.set(fc.callId, fc.args);
  }
}

async function handleToolCallStarted(state: TurnState, event: StreamEvent): Promise<void> {
  const call = readToolCall(event);
  if (!call) {
    return;
  }
  state.openCalls.add(call.callId);
  const args = state.argsByCallId.get(call.callId);
  const presentation = state.params.present(call.name, call.callId, args);
  // How the call presents itself — a delegated agent's call, a tool's own
  // declaration — and, where it says nothing, the serve options' tools.
  const own = readPresentation(event);
  await notifyIfPrimary(state.params, state.primary, {
    sessionUpdate: 'tool_call',
    toolCallId: call.callId,
    title: own.title ?? presentation.title,
    kind: own.kind ?? presentation.kind,
    status: own.status === 'pending' ? 'pending' : presentation.status,
    locations: wireLocations(own.locations) ?? presentation.locations,
    rawInput: asRecord(args),
  });
}

/** A running call's report, as an update of its call. */
async function handleToolProgress(state: TurnState, event: StreamEvent): Promise<void> {
  const call = readToolCall(event);
  if (!call || !state.openCalls.has(call.callId)) {
    return;
  }
  const report = readPresentation(event);
  const content = readContent(event);
  await notifyIfPrimary(state.params, state.primary, {
    sessionUpdate: 'tool_call_update',
    toolCallId: call.callId,
    ...(report.status === undefined
      ? {}
      : {
          status: report.status,
        }),
    ...(report.title === undefined
      ? {}
      : {
          title: report.title,
        }),
    ...(report.kind === undefined
      ? {}
      : {
          kind: report.kind,
        }),
    ...(report.locations === undefined
      ? {}
      : {
          locations: wireLocations(report.locations),
        }),
    ...(content === undefined
      ? {}
      : {
          content: content.map(wireContent),
        }),
    ...(report.progress === undefined
      ? {}
      : {
          _meta: {
            progress: report.progress,
          },
        }),
  });
}

async function handleToolCallCompleted(state: TurnState, event: StreamEvent): Promise<void> {
  const call = readToolCall(event);
  if (!call) {
    return;
  }
  state.openCalls.delete(call.callId);
  const output = typeof event.data.output === 'string' ? event.data.output : undefined;
  const content = readContent(event);
  await notifyIfPrimary(state.params, state.primary, {
    sessionUpdate: 'tool_call_update',
    toolCallId: call.callId,
    status: event.data.error === true ? 'failed' : 'completed',
    // What the call produced as structure (a diff, an image) when it says;
    // else its output (or failure text) as renderable content — the spec's
    // "completed with the output as content, failed carrying the error".
    content:
      content !== undefined
        ? content.map(wireContent)
        : output !== undefined
          ? [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: output,
                },
              },
            ]
          : undefined,
  });
}

/** The plan of the agent that answers the session, as the wire's plan. */
async function handlePlan(state: TurnState, event: StreamEvent, removed: boolean): Promise<void> {
  const plan = event.data.plan;
  const entries = removed
    ? []
    : typeof plan === 'object' && plan !== null && 'entries' in plan && Array.isArray(plan.entries)
      ? frameworkCast<
          Extract<
            ServeSessionUpdate,
            {
              sessionUpdate: 'plan';
            }
          >['entries']
        >(plan.entries)
      : undefined;
  // A plan written as markdown or kept in a file has no entries to show.
  if (entries === undefined) {
    return;
  }
  await notifyIfPrimary(state.params, state.primary, {
    sessionUpdate: 'plan',
    entries,
  });
}

async function handleTurnAborted(state: TurnState, event: StreamEvent): Promise<ServeTurnOutcome> {
  await flushOpenCalls(state, 'failed');
  // The typed error kind (spec 31 gate contract) classifies the abort; the
  // session-level cancel flag covers aborts that carry no kind (a
  // host-initiated harness.abort has only a reason string).
  const errorKind = typeof event.data.errorKind === 'string' ? event.data.errorKind : undefined;
  if (errorKind === 'cancelled' || state.params.cancelRequested()) {
    return {
      kind: 'stop',
      stopReason: 'cancelled',
    };
  }
  if (errorKind === 'model_refused') {
    return {
      kind: 'stop',
      stopReason: 'refusal',
    };
  }
  if (errorKind === 'budget_exceeded') {
    // The closest wire vocabulary for a spent token budget — an editor
    // renders it as a native budget stop instead of a generic error.
    return {
      kind: 'stop',
      stopReason: 'max_tokens',
    };
  }
  return {
    kind: 'error',
    message: typeof event.data.reason === 'string' ? event.data.reason : 'turn aborted',
  };
}

/** Returns an outcome when the event is this turn's boundary; null otherwise. */
async function handleFrameworkEvent(
  state: TurnState,
  event: StreamEvent,
): Promise<ServeTurnOutcome | null> {
  if (hasEventName(event, 'tool_call_started')) {
    await handleToolCallStarted(state, event);
    return null;
  }
  if (hasEventName(event, 'tool_call_completed')) {
    await handleToolCallCompleted(state, event);
    return null;
  }
  if (hasEventName(event, 'tool_progress')) {
    await handleToolProgress(state, event);
    return null;
  }
  if (hasEventName(event, 'plan_updated') || hasEventName(event, 'plan_removed')) {
    await handlePlan(state, event, hasEventName(event, 'plan_removed'));
    return null;
  }
  if (hasEventName(event, 'turn_completed') && matchesTurn(event, state.turnId)) {
    await flushOpenCalls(state, 'completed');
    // The turn's last step decides: one that stopped at a cap says so.
    const stopReason = event.data.stopReason;
    return {
      kind: 'stop',
      stopReason:
        stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? stopReason : 'end_turn',
    };
  }
  if (hasEventName(event, 'turn_aborted') && matchesTurn(event, state.turnId)) {
    return handleTurnAborted(state, event);
  }
  return null;
}

async function notifyIfPrimary(
  params: PumpTurnParams,
  primary: boolean,
  update: ServeSessionUpdate,
): Promise<void> {
  if (!primary) {
    return;
  }
  await params.notify(update);
}

function textChunk(
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
): ServeSessionUpdate {
  return {
    sessionUpdate: kind,
    content: {
      type: 'text',
      text,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return frameworkCast<Record<string, unknown>>(value);
}

//#endregion
