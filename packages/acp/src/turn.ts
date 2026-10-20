/**
 * Accumulates the `session/update` notifications of one ACP prompt turn into an
 * {@link AcpTurnResult}: Noetic conversation items, the assistant text, the
 * agent's plan, its slash commands, and its final mode.
 *
 * All eight of ACP's update variants are handled; see `user_message_chunk`
 * below for the one whose payload is deliberately not turned into an item.
 */

import type {
  AcpAvailableCommand,
  AcpPlanEntry,
  AcpSessionNotification,
  AcpStopReason,
  AcpToolCallContent,
  AcpTurnResult,
  Item,
  TokenUsage,
} from '@noetic-tools/types';
import {
  assistantMessageItem,
  contentBlockText,
  functionCallItem,
  functionCallOutputItem,
} from './items';

//#region Types

type SessionUpdate = AcpSessionNotification['update'];

interface TrackedToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content: AcpToolCallContent[];
  rawOutput?: Record<string, unknown>;
}

//#endregion

//#region Helpers

/**
 * ACP marks "no change" on an update field with `null` and omits fields it is
 * not touching, so both must be excluded before an assignment.
 */
function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Render a tool call's ACP content as the string a `function_call_output` item
 * carries. Diff and terminal content are rendered structurally rather than
 * discarded, so the transcript keeps what the agent actually did.
 */
export function renderToolCallContent(
  content: ReadonlyArray<AcpToolCallContent>,
  rawOutput?: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const entry of content) {
    if (entry.type === 'content') {
      parts.push(contentBlockText(entry.content));
      continue;
    }
    if (entry.type === 'diff') {
      parts.push(`[diff ${entry.path}]\n${entry.newText}`);
      continue;
    }
    parts.push(`[terminal ${entry.terminalId}]`);
  }
  if (parts.length === 0 && rawOutput !== undefined) {
    return JSON.stringify(rawOutput);
  }
  return parts.join('\n');
}

//#endregion

//#region Accumulator

/** @public Folds a turn's session updates into a result. */
export class AcpTurnAccumulator {
  private text = '';
  private reasoning = '';
  private readonly toolCalls = new Map<string, TrackedToolCall>();
  /** Insertion order, so items come out in the order the agent produced them. */
  private readonly toolCallOrder: string[] = [];
  private plan?: AcpPlanEntry[];
  private availableCommands?: AcpAvailableCommand[];
  private currentModeId?: string;

  /** Feed one `session/update` notification. */
  push(notification: AcpSessionNotification): void {
    this.apply(notification.update);
  }

  /** Assistant text accumulated so far. */
  get textContent(): string {
    return this.text;
  }

  /** Reasoning text accumulated so far. */
  get reasoningContent(): string {
    return this.reasoning;
  }

  /** Latest plan snapshot, when the agent reported one. */
  get planEntries(): ReadonlyArray<AcpPlanEntry> | undefined {
    return this.plan;
  }

  /** Build the turn result. */
  result(opts: { stopReason: AcpStopReason; usage?: TokenUsage; cost?: number }): AcpTurnResult {
    const items: Item[] = [];
    if (this.text.length > 0) {
      items.push(assistantMessageItem(this.text));
    }
    for (const id of this.toolCallOrder) {
      const call = this.toolCalls.get(id);
      if (!call) {
        continue;
      }
      items.push(
        functionCallItem({
          title: call.title,
          toolCallId: call.toolCallId,
          rawInput: call.rawInput,
          kind: call.kind,
        }),
      );
      // A pending or in-progress call has no result yet — the turn ended
      // before it settled, so it gets no output item.
      if (call.status !== 'completed' && call.status !== 'failed') {
        continue;
      }
      items.push(
        functionCallOutputItem({
          toolCallId: call.toolCallId,
          output: renderToolCallContent(call.content, call.rawOutput),
          failed: call.status === 'failed',
        }),
      );
    }
    return {
      stopReason: opts.stopReason,
      items,
      text: this.text,
      usage: opts.usage,
      cost: opts.cost,
      plan: this.plan,
      availableCommands: this.availableCommands,
      currentModeId: this.currentModeId,
    };
  }

  //#region internals

  private apply(update: SessionUpdate): void {
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.text += contentBlockText(update.content);
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.reasoning += contentBlockText(update.content);
      return;
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      // Replayed history, sent when the agent reloads a session. It reaches the
      // event stream but is not added to the turn's items: for a session this
      // Noetic run started, the same messages are already in the item log and
      // would double. For a `session.load` of a session Noetic never ran, that
      // history is genuinely not captured here — see the note in the spec.
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      this.trackToolCall(update);
      return;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      this.mergeToolCall(update);
      return;
    }
    if (update.sessionUpdate === 'plan') {
      this.plan = [
        ...update.entries,
      ];
      return;
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this.availableCommands = [
        ...update.availableCommands,
      ];
      return;
    }
    this.currentModeId = update.currentModeId;
  }

  private trackToolCall(
    update: Extract<
      SessionUpdate,
      {
        sessionUpdate: 'tool_call';
      }
    >,
  ): void {
    if (!this.toolCalls.has(update.toolCallId)) {
      this.toolCallOrder.push(update.toolCallId);
    }
    this.toolCalls.set(update.toolCallId, {
      toolCallId: update.toolCallId,
      title: update.title,
      kind: update.kind,
      rawInput: update.rawInput,
      status: update.status ?? 'pending',
      content: update.content
        ? [
            ...update.content,
          ]
        : [],
      rawOutput: update.rawOutput,
    });
  }

  private mergeToolCall(
    update: Extract<
      SessionUpdate,
      {
        sessionUpdate: 'tool_call_update';
      }
    >,
  ): void {
    const existing = this.toolCalls.get(update.toolCallId);
    if (!existing) {
      // An update for a call we never saw announced. Track it anyway rather
      // than dropping the agent's work.
      this.toolCallOrder.push(update.toolCallId);
      this.toolCalls.set(update.toolCallId, {
        toolCallId: update.toolCallId,
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? undefined,
        rawInput: update.rawInput,
        status: update.status ?? 'pending',
        content: update.content
          ? [
              ...update.content,
            ]
          : [],
        rawOutput: update.rawOutput,
      });
      return;
    }
    // ACP sends `null` to mean "no change" and omits fields it is not touching,
    // so only a genuinely present value overwrites what we already tracked.
    if (present(update.title)) {
      existing.title = update.title;
    }
    if (present(update.kind)) {
      existing.kind = update.kind;
    }
    if (present(update.rawInput)) {
      existing.rawInput = update.rawInput;
    }
    if (present(update.rawOutput)) {
      existing.rawOutput = update.rawOutput;
    }
    if (present(update.status)) {
      existing.status = update.status;
    }
    // ACP defines `content` on an update as a REPLACEMENT of the collection,
    // not an append.
    if (present(update.content)) {
      existing.content = [
        ...update.content,
      ];
    }
  }

  //#endregion
}

//#endregion
