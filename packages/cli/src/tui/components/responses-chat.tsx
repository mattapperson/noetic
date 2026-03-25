/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Composes Gridland Message + PromptInput primitives.
 */

import type { StreamableOutputItem } from '@openrouter/sdk';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { ConversationEntry } from '../item-utils.js';
import { extractReasoning, extractTextContent, getItemId, isUserEntry } from '../item-utils.js';
import type { ToolCallState } from './message.js';
import { Message } from './message.js';
import type { ChatStatus } from './prompt-input.js';
import { PromptInput } from './prompt-input.js';

//#region Types

export interface ResponsesChatProps {
  entries: ConversationEntry[];
  status: ChatStatus;
  onSubmit: (text: string) => void;
  onStop?: () => void;
  model?: string;
}

interface RenderContext {
  chatStatus: ChatStatus;
  callNameMap: Map<string, string>;
  entryCount: number;
}

//#endregion

//#region Status Mapping

const USER_ROLE = {
  role: 'user' as const,
};
const ASSISTANT_ROLE = {
  role: 'assistant' as const,
};

function mapItemStatus(status: string | undefined): ToolCallState {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'in_progress' || status === 'searching' || status === 'generating') {
    return 'running';
  }
  if (status === 'incomplete' || status === 'failed') {
    return 'error';
  }
  return 'pending';
}

function buildCallNameMap(entries: ConversationEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!isUserEntry(entry) && entry.type === 'function_call') {
      map.set(entry.callId, entry.name ?? 'tool');
    }
  }
  return map;
}

//#endregion

//#region Shared Tool Call Renderer

interface ToolCallRenderParams {
  key: string;
  name: string;
  state: ToolCallState;
  result?: unknown;
}

function renderToolCall({ key, name, state, result }: ToolCallRenderParams): ReactNode {
  return (
    <Message key={key} {...ASSISTANT_ROLE}>
      <Message.Content>
        <Message.ToolCall name={name} state={state} result={result} />
      </Message.Content>
    </Message>
  );
}

//#endregion

//#region Entry Renderers

function renderUserEntry(
  entry: {
    content: string;
  },
  key: string,
): ReactNode {
  return (
    <Message key={key} {...USER_ROLE}>
      <Message.Content>
        <Message.Text>{entry.content}</Message.Text>
      </Message.Content>
    </Message>
  );
}

function renderMessageItem(
  item: StreamableOutputItem & {
    type: 'message';
  },
  key: string,
  isStreaming: boolean,
): ReactNode {
  const text = extractTextContent(item);
  if (!text) {
    return null;
  }
  return (
    <Message key={key} {...ASSISTANT_ROLE} isStreaming={isStreaming}>
      <Message.Content>
        <Message.Text isLast>{text}</Message.Text>
      </Message.Content>
    </Message>
  );
}

function renderReasoningItem(
  item: StreamableOutputItem & {
    type: 'reasoning';
  },
  key: string,
): ReactNode {
  const text = extractReasoning(item);
  return (
    <Message key={key} {...ASSISTANT_ROLE}>
      <Message.Content>
        <Message.Reasoning collapsed={item.status === 'completed'}>{text}</Message.Reasoning>
      </Message.Content>
    </Message>
  );
}

//#endregion

//#region Entry Dispatch

function renderEntry(entry: ConversationEntry, index: number, ctx: RenderContext): ReactNode {
  if (isUserEntry(entry)) {
    return renderUserEntry(entry, `user-${index}`);
  }

  const key = getItemId(entry);
  const isLastEntry = index === ctx.entryCount - 1;
  const isStreaming = isLastEntry && ctx.chatStatus === 'streaming' && entry.status !== 'completed';

  if (entry.type === 'message') {
    return renderMessageItem(entry, key, isStreaming);
  }

  if (entry.type === 'reasoning') {
    return renderReasoningItem(entry, key);
  }

  if (entry.type === 'function_call') {
    return renderToolCall({
      key,
      name: entry.name ?? 'tool',
      state: mapItemStatus(entry.status),
    });
  }

  if (entry.type === 'function_call_output') {
    return renderToolCall({
      key,
      name: ctx.callNameMap.get(entry.callId) ?? 'tool',
      state: 'completed',
      result: entry.output,
    });
  }

  if (entry.type === 'web_search_call') {
    return renderToolCall({
      key,
      name: 'web_search',
      state: mapItemStatus(entry.status),
    });
  }

  if (entry.type === 'file_search_call') {
    return renderToolCall({
      key,
      name: 'file_search',
      state: mapItemStatus(entry.status),
    });
  }

  if (entry.type === 'image_generation_call') {
    return renderToolCall({
      key,
      name: 'image_generation',
      state: mapItemStatus(entry.status),
    });
  }

  return null;
}

//#endregion

//#region Component

export function ResponsesChat({
  entries,
  status,
  onSubmit,
  onStop,
  model,
}: ResponsesChatProps): ReactNode {
  const callNameMap = useMemo(
    () => buildCallNameMap(entries),
    [
      entries,
    ],
  );

  function handleSubmit(msg: { text: string }): void {
    onSubmit(msg.text);
  }

  const ctx: RenderContext = {
    chatStatus: status,
    callNameMap,
    entryCount: entries.length,
  };

  return (
    <box flexDirection="column" height="100%">
      <scrollbox flex={1}>{entries.map((entry, i) => renderEntry(entry, i, ctx))}</scrollbox>
      <PromptInput status={status} onSubmit={handleSubmit} onStop={onStop} model={model} />
    </box>
  );
}

//#endregion
