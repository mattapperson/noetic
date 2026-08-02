import type { FrameworkStreamEvent, StreamEvent } from '@noetic-tools/types';
import type { ChatStreamChunk } from './chat-types';

export interface StreamToChatChunksOptions {
  /**
   * The `messageId` passed to `harness.execute()`. The translator waits for
   * the `turn_started` (or mid-turn `inbox_injected`) event carrying this id,
   * so replayed events from earlier turns and concurrent turns are skipped.
   * When several queued messages coalesce into one turn, only the FIRST id in
   * the batch claims it — the other handlers' translators end without
   * emitting, so the shared reply is posted exactly once.
   */
  messageId: string;
  /** Renders a task-card title for a tool call. Default: the tool name. */
  taskTitle?: (toolName: string, callId: string) => string;
  /** Inserted between assistant messages within one turn. Default: blank line. */
  separator?: string;
  /**
   * Renders the notice posted when a turn aborts; return `null` to post
   * nothing. The default deliberately omits the abort reason — it is a raw
   * internal error message, not something to show a chat channel.
   */
  abortNotice?: (reason: string) => string | null;
}

type TurnClaim =
  | {
      kind: 'ours';
      turnId: string | null;
    }
  | {
      kind: 'foreign';
    }
  | {
      kind: 'none';
    };

/**
 * Translate a harness event stream into Chat SDK stream chunks: text deltas
 * pass through as strings, tool calls become `task_update` cards, and the
 * stream ends at the turn boundary — `thread.post()` resolves only when the
 * iterable terminates.
 */
export async function* streamToChatChunks(
  events: AsyncIterable<StreamEvent>,
  options: StreamToChatChunksOptions,
): AsyncIterable<string | ChatStreamChunk> {
  const separator = options.separator ?? '\n\n';
  const taskTitle = options.taskTitle ?? ((toolName: string) => toolName);
  const abortNotice = options.abortNotice ?? (() => '_(turn aborted)_');
  let claimed = false;
  /** null after an `inbox_injected` claim: end at the NEXT turn boundary, whatever its id. */
  let turnId: string | null = null;
  let emittedText = false;
  let pendingSeparator = false;
  /** Tool calls started but not yet completed — flushed at the turn boundary. */
  const openCalls = new Map<string, string>();

  for await (const event of events) {
    if (!claimed) {
      const claim = matchClaim(event, options.messageId);
      if (claim.kind === 'foreign') {
        return;
      }
      if (claim.kind === 'ours') {
        claimed = true;
        turnId = claim.turnId;
      }
      continue;
    }

    if (event.source === 'sdk') {
      if (event.type === 'response.output_text.delta' && typeof event.data.delta === 'string') {
        if (pendingSeparator) {
          pendingSeparator = false;
          yield separator;
        }
        emittedText = true;
        yield event.data.delta;
        continue;
      }
      // A later assistant message in the same turn (e.g. after a tool round)
      // would otherwise concatenate onto the previous one without a break.
      if (event.type === 'response.output_item.added' && isMessageItem(event.data.item)) {
        pendingSeparator = emittedText;
      }
      continue;
    }

    if (hasEventName(event, 'tool_call_started')) {
      const call = readToolCall(event);
      if (call) {
        openCalls.set(call.callId, call.name);
        yield taskUpdate(call, taskTitle, 'in_progress');
      }
      continue;
    }
    if (hasEventName(event, 'tool_call_completed')) {
      const call = readToolCall(event);
      if (call) {
        openCalls.delete(call.callId);
        yield taskUpdate(call, taskTitle, event.data.error === true ? 'error' : 'complete');
      }
      continue;
    }
    if (hasEventName(event, 'turn_completed') && matchesTurn(event, turnId)) {
      yield* flushOpenCalls(openCalls, taskTitle, 'complete');
      return;
    }
    if (hasEventName(event, 'turn_aborted') && matchesTurn(event, turnId)) {
      yield* flushOpenCalls(openCalls, taskTitle, 'error');
      const reason = typeof event.data.reason === 'string' ? event.data.reason : 'aborted';
      const notice = abortNotice(reason);
      if (notice) {
        yield `${emittedText ? separator : ''}${notice}`;
      }
      return;
    }
  }
}

function matchClaim(event: StreamEvent, messageId: string): TurnClaim {
  if (hasEventName(event, 'turn_started')) {
    return claimFromIds(event.data.messageIds, messageId, readTurnId(event));
  }
  // A 'between-rounds' delivery lands mid-turn and never appears in a
  // turn_started; the injection event is its claim, and the running turn's
  // boundary (whatever its id) is its end.
  if (hasEventName(event, 'inbox_injected')) {
    return claimFromIds(event.data.messageIds, messageId, null);
  }
  return {
    kind: 'none',
  };
}

function claimFromIds(ids: unknown, messageId: string, turnId: string | null): TurnClaim {
  if (!Array.isArray(ids) || !ids.includes(messageId)) {
    return {
      kind: 'none',
    };
  }
  if (ids[0] !== messageId) {
    return {
      kind: 'foreign',
    };
  }
  return {
    kind: 'ours',
    turnId,
  };
}

function readTurnId(event: StreamEvent): string | null {
  return typeof event.data.turnId === 'string' ? event.data.turnId : null;
}

function matchesTurn(event: StreamEvent, turnId: string | null): boolean {
  return turnId === null || event.data.turnId === turnId;
}

function taskUpdate(
  call: {
    name: string;
    callId: string;
  },
  taskTitle: (toolName: string, callId: string) => string,
  status: 'in_progress' | 'complete' | 'error',
): ChatStreamChunk {
  return {
    type: 'task_update',
    id: call.callId,
    title: taskTitle(call.name, call.callId),
    status,
  };
}

function* flushOpenCalls(
  openCalls: Map<string, string>,
  taskTitle: (toolName: string, callId: string) => string,
  status: 'complete' | 'error',
): Iterable<ChatStreamChunk> {
  for (const [callId, name] of openCalls) {
    yield taskUpdate(
      {
        name,
        callId,
      },
      taskTitle,
      status,
    );
  }
  openCalls.clear();
}

/**
 * Framework event types are prefixed with the harness `config.name`
 * (`myagent:turn_started`), so matching is on the suffix.
 */
function hasEventName(event: StreamEvent, name: string): boolean {
  return event.source === 'framework' && event.type.endsWith(`:${name}`);
}

function readToolCall(event: FrameworkStreamEvent): {
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

function isMessageItem(item: unknown): boolean {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'message';
}
