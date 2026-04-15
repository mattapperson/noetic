/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Renders each item type with Claude Code-style presentation.
 */

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
import type { SpinnerMode, ToolCallStatus } from './items/index.js';
import {
  AssistantText,
  LoadingSpinner,
  Reasoning,
  SystemMessage,
  ToolCall,
  ToolResult,
  UserPrompt,
} from './items/index.js';
import type { ChatStatus } from './prompt-input.js';
import { PromptInput } from './prompt-input.js';

//#region Types

export interface ResponsesChatProps {
  entries: ConversationEntry[];
  status: ChatStatus;
  onSubmit: (text: string) => void;
  onStop?: () => void;
  model?: string;
  commands?: Array<{
    cmd: string;
    desc?: string;
  }>;
  modalContent?: ReactNode;
  onModalClose?: () => void;
}

/**
 * Visual category of an entry — drives vertical spacing between consecutive
 * entries. `tool-result` never gets a top margin; other categories get one
 * when they follow an entry of a different category.
 */
type EntryCategory =
  | 'user'
  | 'assistant-text'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'system';

interface RenderContext {
  chatStatus: ChatStatus;
  callStatusMap: Map<string, ToolCallStatus>;
  entryCount: number;
  categories: EntryCategory[];
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

function buildCallStatusMap(entries: ConversationEntry[]): Map<string, ToolCallStatus> {
  const statuses = new Map<string, ToolCallStatus>();
  for (const entry of entries) {
    if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
      continue;
    }
    if (entry.type === 'function_call') {
      statuses.set(entry.callId, mapItemStatus(entry.status));
    }
  }
  return statuses;
}

function categorize(entry: ConversationEntry): EntryCategory {
  if (isUserEntry(entry)) {
    return 'user';
  }
  if (isErrorEntry(entry) || isSystemEntry(entry)) {
    return 'system';
  }
  if (entry.type === 'message') {
    return 'assistant-text';
  }
  if (entry.type === 'reasoning') {
    return 'reasoning';
  }
  if (entry.type === 'function_call_output') {
    return 'tool-result';
  }
  return 'tool-call';
}

function computeCategories(entries: ConversationEntry[]): EntryCategory[] {
  return entries.map(categorize);
}

function shouldAddMargin(categories: EntryCategory[], index: number): boolean {
  if (index <= 0) {
    return false;
  }
  const current = categories[index];
  const previous = categories[index - 1];
  if (current === undefined || previous === undefined) {
    return false;
  }
  if (current === 'tool-result') {
    return false;
  }
  return previous !== current;
}

/**
 * True when the previous entry is part of an assistant turn — used to decide
 * whether a system/error message should render as a sub-response (⎿ prefix)
 * under the assistant turn rather than as a standalone top-level line.
 */
function isPartOfAssistantTurn(categories: EntryCategory[], index: number): boolean {
  if (index <= 0) {
    return false;
  }
  const previous = categories[index - 1];
  return (
    previous === 'assistant-text' ||
    previous === 'reasoning' ||
    previous === 'tool-call' ||
    previous === 'tool-result'
  );
}

//#endregion

//#region Argument Preview

const MAX_ARGS_PREVIEW = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function previewArgs(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const preferred = [
        'path',
        'file',
        'file_path',
        'command',
        'pattern',
        'query',
      ];
      for (const key of preferred) {
        const value = parsed[key];
        if (typeof value === 'string') {
          return truncate(value, MAX_ARGS_PREVIEW);
        }
      }
      // Parsed as a record but no preferred key — don't dump raw JSON; better
      // to show no args than `{"recursive":true,"depth":3}`.
      return '';
    }
  } catch {
    // Not JSON — fall through to raw truncation.
  }
  return truncate(trimmed, MAX_ARGS_PREVIEW);
}

//#endregion

//#region Entry Dispatch

function renderEntry(entry: ConversationEntry, index: number, ctx: RenderContext): ReactNode {
  const addMargin = shouldAddMargin(ctx.categories, index);

  if (isUserEntry(entry)) {
    return <UserPrompt key={`user-${index}`} text={entry.content} addMargin={addMargin} />;
  }

  if (isErrorEntry(entry)) {
    const asResponse = isPartOfAssistantTurn(ctx.categories, index);
    return (
      <SystemMessage
        key={`error-${index}`}
        text={entry.content}
        type="error"
        asResponse={asResponse}
        addMargin={!asResponse && addMargin}
      />
    );
  }

  if (isSystemEntry(entry)) {
    return (
      <SystemMessage
        key={`system-${index}`}
        text={entry.content}
        type="info"
        addMargin={addMargin}
      />
    );
  }

  const key = getItemId(entry);
  const isLastEntry = index === ctx.entryCount - 1;

  if (entry.type === 'message') {
    const text = extractTextContent(entry);
    if (!text) {
      return null;
    }
    const isStreaming =
      isLastEntry && ctx.chatStatus === 'streaming' && entry.status !== 'completed';
    return <AssistantText key={key} text={text} isStreaming={isStreaming} addMargin={addMargin} />;
  }

  if (entry.type === 'reasoning') {
    return (
      <Reasoning
        key={key}
        text={extractReasoning(entry)}
        collapsed={entry.status === 'completed'}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'function_call') {
    return (
      <ToolCall
        key={key}
        name={entry.name ?? 'tool'}
        status={mapItemStatus(entry.status)}
        args={previewArgs(entry.arguments ?? '')}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'function_call_output') {
    const callStatus = ctx.callStatusMap.get(entry.callId);
    return <ToolResult key={key} output={entry.output} isError={callStatus === 'error'} />;
  }

  if (entry.type === 'web_search_call') {
    return (
      <ToolCall
        key={key}
        name="web_search"
        status={mapItemStatus(entry.status)}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'file_search_call') {
    return (
      <ToolCall
        key={key}
        name="file_search"
        status={mapItemStatus(entry.status)}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'image_generation_call') {
    return (
      <ToolCall
        key={key}
        name="image_generation"
        status={mapItemStatus(entry.status)}
        addMargin={addMargin}
      />
    );
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
  const callStatusMap = useMemo(
    () => buildCallStatusMap(entries),
    [
      entries,
    ],
  );
  const categories = useMemo(
    () => computeCategories(entries),
    [
      entries,
    ],
  );

  function handleSubmit(msg: { text: string }): void {
    onSubmit(msg.text);
  }

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
    callStatusMap,
    entryCount: entries.length,
    categories,
  };

  const lastEntry = entries[entries.length - 1];
  const hasStreamingEntry =
    status === 'streaming' && lastEntry !== undefined && !isUserEntry(lastEntry);
  const completedEntries = hasStreamingEntry ? entries.slice(0, -1) : entries;
  const streamingEntry = hasStreamingEntry ? lastEntry : null;

  const showLoadingSpinner = useMemo(() => {
    if (status !== 'streaming') {
      return false;
    }

    let lastUserIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry && isUserEntry(entry)) {
        lastUserIndex = i;
        break;
      }
    }

    const entriesAfterUser = entries.slice(lastUserIndex + 1);
    if (entriesAfterUser.length === 0) {
      return true;
    }

    const hasVisibleText = entriesAfterUser.some((entry) => {
      if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
        return false;
      }
      if (entry.type === 'message') {
        return extractTextContent(entry).length > 0;
      }
      return false;
    });

    return !hasVisibleText;
  }, [
    entries,
    status,
  ]);

  const spinnerMode: SpinnerMode = useMemo(() => {
    if (!showLoadingSpinner) {
      return 'loading';
    }

    const lastNonUserEntry = [
      ...entries,
    ]
      .reverse()
      .find((e) => !isUserEntry(e) && !isErrorEntry(e) && !isSystemEntry(e));

    if (lastNonUserEntry && 'type' in lastNonUserEntry && lastNonUserEntry.type === 'reasoning') {
      return 'thinking';
    }

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
