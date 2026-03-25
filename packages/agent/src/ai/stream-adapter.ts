/**
 * Maps StreamableOutputItem from getItemsStream() to Chat UI state.
 *
 * Items are emitted cumulatively — the same item ID is yielded multiple times
 * with progressively accumulated content.
 */

import type { StreamableOutputItem } from '@openrouter/sdk';
import type { ChatMessage, ToolCallDisplay } from '../types/chat.js';
import { ChatStatus } from '../types/chat.js';

//#region Types

interface ItemState {
  items: Map<string, StreamableOutputItem>;
  orderedIds: string[];
}

//#endregion

//#region Item ID Extraction

export function createIdGenerator(): (item: StreamableOutputItem) => string {
  let counter = 0;
  return (item: StreamableOutputItem): string => {
    if (item.type === 'function_call') {
      return `call-${item.callId}`;
    }
    if (item.type === 'function_call_output') {
      return item.id ?? `call-output-${item.callId}`;
    }
    return item.id ?? `anon-${++counter}`;
  };
}

//#endregion

//#region Item → Message Conversion

export function extractTextContent(item: StreamableOutputItem): string {
  if (item.type !== 'message') {
    return '';
  }
  if (typeof item.content === 'string') {
    return item.content;
  }
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content
    .filter(
      (
        part,
      ): part is {
        type: 'output_text';
        text: string;
      } => part.type === 'output_text',
    )
    .map((part) => part.text)
    .join('');
}

function extractReasoning(item: StreamableOutputItem): string | undefined {
  if (item.type !== 'reasoning') {
    return undefined;
  }
  if (!Array.isArray(item.content)) {
    return undefined;
  }
  return item.content
    .filter(
      (
        part,
      ): part is {
        type: 'reasoning_text';
        text: string;
      } => part.type === 'reasoning_text',
    )
    .map((part) => part.text)
    .join('');
}

function itemToToolCall(item: StreamableOutputItem): ToolCallDisplay | undefined {
  if (item.type === 'function_call') {
    return {
      id: item.callId ?? 'unknown',
      name: item.name ?? 'unknown',
      arguments: item.arguments ?? '',
      status: item.status === 'completed' ? 'completed' : 'running',
    };
  }

  if (item.type === 'function_call_output') {
    return {
      id: item.callId ?? 'unknown',
      name: 'tool_result',
      arguments: '',
      result: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      status: 'completed',
    };
  }

  return undefined;
}

//#endregion

//#region Public API

export interface StreamAdapter {
  processItem: (item: StreamableOutputItem) => void;
  getMessages: () => ChatMessage[];
  getStreamingText: () => string;
  getActiveToolCalls: () => ToolCallDisplay[];
  getStatus: () => ChatStatus;
  setStatus: (status: ChatStatus) => void;
  reset: () => void;
}

export function createStreamAdapter(): StreamAdapter {
  const state: ItemState = {
    items: new Map(),
    orderedIds: [],
  };
  let currentStatus: ChatStatus = ChatStatus.Ready;
  const getId = createIdGenerator();

  function processItem(item: StreamableOutputItem): void {
    const id = getId(item);
    if (!state.items.has(id)) {
      state.orderedIds.push(id);
    }
    state.items.set(id, item);
    currentStatus = ChatStatus.Streaming;
  }

  function getMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let currentMessage: ChatMessage | null = null;

    for (const id of state.orderedIds) {
      const item = state.items.get(id);
      if (!item) {
        continue;
      }

      if (item.type === 'message') {
        if (currentMessage) {
          messages.push(currentMessage);
        }
        currentMessage = {
          id,
          role: 'assistant',
          content: extractTextContent(item),
        };
        continue;
      }

      if (item.type === 'reasoning') {
        if (currentMessage) {
          currentMessage.reasoning = extractReasoning(item);
        }
        continue;
      }

      const toolCall = itemToToolCall(item);
      if (!toolCall) {
        continue;
      }

      if (item.type === 'function_call') {
        if (!currentMessage) {
          currentMessage = {
            id: `msg-${id}`,
            role: 'assistant',
            content: '',
          };
        }
        if (!currentMessage.toolCalls) {
          currentMessage.toolCalls = [];
        }
        const existingIdx = currentMessage.toolCalls.findIndex((tc) => tc.id === toolCall.id);
        if (existingIdx >= 0) {
          currentMessage.toolCalls[existingIdx] = toolCall;
        } else {
          currentMessage.toolCalls.push(toolCall);
        }
        continue;
      }

      if (item.type !== 'function_call_output' || !currentMessage?.toolCalls) {
        continue;
      }
      const matching = currentMessage.toolCalls.find((tc) => tc.id === toolCall.id);
      if (!matching) {
        continue;
      }
      matching.result = toolCall.result;
      matching.status = 'completed';
    }

    if (currentMessage) {
      messages.push(currentMessage);
    }

    return messages;
  }

  function getStreamingText(): string {
    for (let i = state.orderedIds.length - 1; i >= 0; i--) {
      const item = state.items.get(state.orderedIds[i]);
      if (item?.type === 'message' && item.status === 'in_progress') {
        return extractTextContent(item);
      }
    }
    return '';
  }

  function getActiveToolCalls(): ToolCallDisplay[] {
    const active: ToolCallDisplay[] = [];
    for (const id of state.orderedIds) {
      const item = state.items.get(id);
      if (!item) {
        continue;
      }
      if (item.type !== 'function_call') {
        continue;
      }
      if (item.status === 'completed') {
        continue;
      }
      const tc = itemToToolCall(item);
      if (tc) {
        active.push(tc);
      }
    }
    return active;
  }

  function getStatus(): ChatStatus {
    return currentStatus;
  }

  function setStatus(status: ChatStatus): void {
    currentStatus = status;
  }

  function reset(): void {
    state.items.clear();
    state.orderedIds.length = 0;
    currentStatus = ChatStatus.Ready;
  }

  return {
    processItem,
    getMessages,
    getStreamingText,
    getActiveToolCalls,
    getStatus,
    setStatus,
    reset,
  };
}

//#endregion
