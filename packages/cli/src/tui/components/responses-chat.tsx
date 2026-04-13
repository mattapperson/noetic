/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Renders each item type with Claude Code-style presentation.
 */

import type { Item } from '@noetic/core';
import { Box, Static, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { ConversationEntry } from '../item-utils.js';
import {
  extractReasoning,
  extractTextContent,
  getItemId,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../item-utils.js';
import { AssistantText } from './items/assistant-text.js';
import type { SpinnerMode } from './items/loading-spinner.js';
import { LoadingSpinner } from './items/loading-spinner.js';
import { Reasoning } from './items/reasoning.js';
import { SystemMessage } from './items/system-message.js';
import type { ToolCallStatus } from './items/tool-call.js';
import { ToolCall } from './items/tool-call.js';
import { UserPrompt } from './items/user-prompt.js';
import type { ChatStatus } from './prompt-input.js';
import { PromptInput } from './prompt-input.js';

//#region Types

export interface ResponsesChatProps {
  entries: ConversationEntry[];
  status: ChatStatus;
  onSubmit: (text: string) => void;
  onStop?: () => void;
  model?: string;
  /** Slash commands for autocomplete */
  commands?: Array<{
    cmd: string;
    desc?: string;
  }>;
  /** Modal content to display over chat area */
  modalContent?: ReactNode;
  /** Called when modal should be dismissed (Escape pressed) */
  onModalClose?: () => void;
}

interface RenderContext {
  chatStatus: ChatStatus;
  callNameMap: Map<string, string>;
  entryCount: number;
}

//#endregion

//#region Status Mapping

function mapItemStatus(status: string | undefined): ToolCallStatus {
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

//#region Entry Renderers

function renderUserEntry(
  entry: {
    content: string;
  },
  key: string,
): ReactNode {
  return <UserPrompt key={key} text={entry.content} />;
}

function renderMessageItem(
  item: Item & {
    type: 'message';
  },
  key: string,
  isStreaming: boolean,
): ReactNode {
  const text = extractTextContent(item);
  if (!text) {
    return null;
  }
  return <AssistantText key={key} text={text} isStreaming={isStreaming} />;
}

function renderReasoningItem(
  item: Item & {
    type: 'reasoning';
  },
  key: string,
): ReactNode {
  const text = extractReasoning(item);
  return <Reasoning key={key} text={text} collapsed={item.status === 'completed'} />;
}

interface ToolCallRenderParams {
  key: string;
  name: string;
  status: ToolCallStatus;
  result?: unknown;
}

function renderToolCallItem({ key, name, status, result }: ToolCallRenderParams): ReactNode {
  return <ToolCall key={key} name={name} status={status} result={result} />;
}

//#endregion

//#region Entry Dispatch

function renderEntry(entry: ConversationEntry, index: number, ctx: RenderContext): ReactNode {
  if (isUserEntry(entry)) {
    return renderUserEntry(entry, `user-${index}`);
  }

  if (isErrorEntry(entry)) {
    return <SystemMessage key={`error-${index}`} text={entry.content} type="error" />;
  }

  if (isSystemEntry(entry)) {
    return <SystemMessage key={`system-${index}`} text={entry.content} type="info" />;
  }

  const key = getItemId(entry);
  const isLastEntry = index === ctx.entryCount - 1;

  if (entry.type === 'message') {
    const isStreaming =
      isLastEntry && ctx.chatStatus === 'streaming' && entry.status !== 'completed';
    return renderMessageItem(entry, key, isStreaming);
  }

  if (entry.type === 'reasoning') {
    return renderReasoningItem(entry, key);
  }

  if (entry.type === 'function_call') {
    return renderToolCallItem({
      key,
      name: entry.name ?? 'tool',
      status: mapItemStatus(entry.status),
    });
  }

  if (entry.type === 'function_call_output') {
    return renderToolCallItem({
      key,
      name: ctx.callNameMap.get(entry.callId) ?? 'tool',
      status: 'completed',
      result: entry.output,
    });
  }

  if (entry.type === 'web_search_call') {
    return renderToolCallItem({
      key,
      name: 'web_search',
      status: mapItemStatus(entry.status),
    });
  }

  if (entry.type === 'file_search_call') {
    return renderToolCallItem({
      key,
      name: 'file_search',
      status: mapItemStatus(entry.status),
    });
  }

  if (entry.type === 'image_generation_call') {
    return renderToolCallItem({
      key,
      name: 'image_generation',
      status: mapItemStatus(entry.status),
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
  commands,
  modalContent,
  onModalClose,
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

  // Handle Escape when modal is open (PromptInput is not rendered so we need this)
  useInput(
    (_input, key) => {
      if (key.escape && modalContent && onModalClose) {
        onModalClose();
      }
    },
    {
      isActive: !!modalContent,
    },
  );

  const ctx: RenderContext = {
    chatStatus: status,
    callNameMap,
    entryCount: entries.length,
  };

  // Split entries into completed (for Static) and streaming (for live updates).
  // Static renders items once and never updates them, so streaming content
  // must be rendered outside Static.
  //
  // Only treat the last entry as "streaming" if:
  // 1. We're in streaming status
  // 2. The last entry is NOT a user entry (user entries don't stream)
  // 3. There's at least one entry
  const lastEntry = entries[entries.length - 1];
  const hasStreamingEntry =
    status === 'streaming' && lastEntry !== undefined && !isUserEntry(lastEntry);
  const completedEntries = hasStreamingEntry ? entries.slice(0, -1) : entries;
  const streamingEntry = hasStreamingEntry ? lastEntry : null;

  // Determine if we should show the loading spinner
  // Show when streaming and either:
  // - No entries at all after user message
  // - Last entry is reasoning (thinking mode)
  // - Last entry has no visible text content yet
  const showLoadingSpinner = useMemo(() => {
    if (status !== 'streaming') {
      return false;
    }

    // Find the last user entry index
    let lastUserIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && isUserEntry(entry)) {
        lastUserIndex = i;
        break;
      }
    }

    // Get entries after the last user message
    const entriesAfterUser = entries.slice(lastUserIndex + 1);

    // No assistant entries yet - show spinner
    if (entriesAfterUser.length === 0) {
      return true;
    }

    // Check if we have any visible text content
    const hasVisibleText = entriesAfterUser.some((entry) => {
      if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
        return false;
      }
      if (entry.type === 'message') {
        return extractTextContent(entry).length > 0;
      }
      return false;
    });

    // Show spinner if no visible text yet
    return !hasVisibleText;
  }, [
    entries,
    status,
  ]);

  // Determine spinner mode
  const spinnerMode: SpinnerMode = useMemo(() => {
    if (!showLoadingSpinner) {
      return 'loading';
    }

    // Check if the last entry is reasoning
    const lastNonUserEntry = [
      ...entries,
    ]
      .reverse()
      .find((e) => !isUserEntry(e) && !isErrorEntry(e) && !isSystemEntry(e));

    if (lastNonUserEntry && 'type' in lastNonUserEntry && lastNonUserEntry.type === 'reasoning') {
      return 'thinking';
    }

    // Check if there's an active tool call
    const hasActiveTool = entries.some((e) => {
      if (isUserEntry(e) || isErrorEntry(e) || isSystemEntry(e)) {
        return false;
      }
      if (e.type === 'function_call' && e.status !== 'completed') {
        return true;
      }
      return false;
    });

    if (hasActiveTool) {
      return 'tool-use';
    }

    return 'loading';
  }, [
    entries,
    showLoadingSpinner,
  ]);

  // Wrap completed entries for Static component
  const staticItems = useMemo(
    () =>
      completedEntries.map((entry, i) => ({
        key: isUserEntry(entry)
          ? `user-${i}`
          : isErrorEntry(entry)
            ? `error-${i}`
            : isSystemEntry(entry)
              ? `system-${i}`
              : getItemId(entry),
        entry,
        index: i,
      })),
    [
      completedEntries,
    ],
  );

  // When modal is open, hide the prompt and show modal with Esc hint
  if (modalContent) {
    return (
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" flexGrow={1}>
          {modalContent}
        </Box>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <Static items={staticItems}>
          {(item: { key: string; entry: ConversationEntry; index: number }) => (
            <Box key={item.key}>{renderEntry(item.entry, item.index, ctx)}</Box>
          )}
        </Static>
        {streamingEntry && <Box>{renderEntry(streamingEntry, entries.length - 1, ctx)}</Box>}
        {showLoadingSpinner && <LoadingSpinner mode={spinnerMode} />}
      </Box>
      <PromptInput
        status={status}
        onSubmit={handleSubmit}
        onStop={onStop}
        onModalClose={onModalClose}
        isModalOpen={!!modalContent}
        model={model}
        commands={commands}
      />
    </Box>
  );
}

//#endregion
