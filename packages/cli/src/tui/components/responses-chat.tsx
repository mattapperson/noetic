/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Renders each item type with Claude Code-style presentation.
 *
 * Rendering model:
 * - Completed entries are rendered through <Static>, which is append-only
 *   (Ink never reprints items already emitted to stdout).
 * - The currently streaming assistant message is split by newline:
 *   every complete line (i.e. any line followed by "\n") is committed to
 *   <Static> as its own sub-item with a stable key, and only the
 *   trailing partial line remains in the live region. This keeps the
 *   live region ≤ a few terminal rows so Ink's log-update can always
 *   properly erase it — otherwise Ink's clear stops at the terminal top
 *   edge and each re-render duplicates the overflow into scrollback.
 * - Every <Static> item is wrapped in a Box with explicit terminal-width.
 *   Items rendered through Static are measured with no parent width
 *   constraint, so flexGrow-based layouts don't know how wide to wrap.
 *   Without this, Text "wrap" falls through and the terminal hard-wraps
 *   mid-word at its column boundary.
 */

import type { Item } from '@noetic/core';
import { Box, Static, Text, useInput, useStdout } from 'ink';
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
  AssistantTextLine,
  LoadingSpinner,
  Reasoning,
  SystemMessage,
  ToolCall,
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

interface StaticSubItem {
  key: string;
  node: ReactNode;
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

function messageLines(item: Item & { type: 'message' }): string[] {
  // Split by '\n' so each emitted line becomes its own sub-item. A trailing
  // '\n' produces a final '' entry — that represents a blank tail line the
  // streamer hasn't written into yet; we still want to preserve blank
  // lines in the middle of the message for paragraph spacing.
  return extractTextContent(item).split('\n');
}

function renderToolCallForEntry(
  entry: ConversationEntry,
  callNameMap: Map<string, string>,
): ReactNode {
  if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
    return null;
  }
  if (entry.type === 'function_call') {
    return <ToolCall name={entry.name ?? 'tool'} status={mapItemStatus(entry.status)} />;
  }
  if (entry.type === 'function_call_output') {
    return (
      <ToolCall
        name={callNameMap.get(entry.callId) ?? 'tool'}
        status="completed"
        result={entry.output}
      />
    );
  }
  if (entry.type === 'web_search_call') {
    return <ToolCall name="web_search" status={mapItemStatus(entry.status)} />;
  }
  if (entry.type === 'file_search_call') {
    return <ToolCall name="file_search" status={mapItemStatus(entry.status)} />;
  }
  if (entry.type === 'image_generation_call') {
    return <ToolCall name="image_generation" status={mapItemStatus(entry.status)} />;
  }
  return null;
}

function renderNonMessageEntry(
  entry: ConversationEntry,
  keySuffix: string,
  callNameMap: Map<string, string>,
): ReactNode {
  if (isUserEntry(entry)) {
    return <UserPrompt text={entry.content} />;
  }
  if (isErrorEntry(entry)) {
    return <SystemMessage text={entry.content} type="error" />;
  }
  if (isSystemEntry(entry)) {
    return <SystemMessage text={entry.content} type="info" />;
  }
  if (entry.type === 'reasoning') {
    const text = extractReasoning(entry);
    return <Reasoning text={text} collapsed={entry.status === 'completed'} />;
  }
  void keySuffix;
  return renderToolCallForEntry(entry, callNameMap);
}

//#endregion

//#region Static Sub-Item Building

/**
 * Convert entries to a flat list of Static sub-items.
 *
 * Every assistant message is split into per-line sub-items so that the
 * last (partial) line of the currently-streaming message can stay out
 * of <Static> while all earlier lines commit in append-only fashion.
 *
 * Keys:
 *   user:<index>                     — user turn
 *   error:<index>                    — error banner
 *   system:<index>                   — system/info line
 *   <itemId>:L<n>                    — nth line of an assistant message
 *   <itemId>                         — any other assistant item (tool call,
 *                                      reasoning, etc.)
 *
 * Keys stay stable across renders because message ids and line indices
 * both stay stable once emitted — message text grows only by appending.
 */
function buildStaticSubItems(
  entries: ConversationEntry[],
  streamingIndex: number | null,
  callNameMap: Map<string, string>,
  columns: number,
): StaticSubItem[] {
  const out: StaticSubItem[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }

    if (isUserEntry(entry)) {
      out.push({
        key: `user-${i}`,
        node: renderNonMessageEntry(entry, `user-${i}`, callNameMap),
      });
      continue;
    }
    if (isErrorEntry(entry)) {
      out.push({
        key: `error-${i}`,
        node: renderNonMessageEntry(entry, `error-${i}`, callNameMap),
      });
      continue;
    }
    if (isSystemEntry(entry)) {
      out.push({
        key: `system-${i}`,
        node: renderNonMessageEntry(entry, `system-${i}`, callNameMap),
      });
      continue;
    }

    const itemId = getItemId(entry);

    if (entry.type === 'message') {
      const lines = messageLines(entry);
      const isStreaming = i === streamingIndex;
      // When streaming, drop the trailing partial line — the live region
      // owns it. When not streaming, everything is committed.
      const commitCount = isStreaming ? lines.length - 1 : lines.length;
      for (let li = 0; li < commitCount; li++) {
        const lineText = lines[li] ?? '';
        out.push({
          key: `${itemId}:L${li}`,
          node: <AssistantTextLine text={lineText} isFirst={li === 0} width={columns} />,
        });
      }
      continue;
    }

    // Non-message assistant items (reasoning, tool calls, etc.). Skip the
    // streaming tail — it re-renders in the live region until complete.
    if (i === streamingIndex) {
      continue;
    }
    out.push({
      key: itemId,
      node: renderNonMessageEntry(entry, itemId, callNameMap),
    });
  }

  return out;
}

//#endregion

//#region Live Region Rendering

/**
 * Render the live (non-Static) portion of the currently streaming entry.
 * For messages this is the last partial line with a streaming cursor; for
 * other item types it's the whole item (they re-render until complete).
 *
 * When a single "line" (paragraph with no embedded \n) has already grown
 * past a few terminal rows, we display only its tail. The live region is
 * managed by Ink's log-update, which can only erase up to the terminal's
 * top edge. If live content exceeds terminal height, each re-render
 * pushes the overflow into scrollback — producing the duplicated-prefix
 * artifact observed when streaming long paragraphs. Truncating the live
 * display keeps it well below terminal height; the full paragraph still
 * becomes visible once streaming completes and the message commits to
 * <Static>.
 */
function renderLiveEntry(
  entry: ConversationEntry,
  callNameMap: Map<string, string>,
  columns: number,
  rows: number,
): ReactNode {
  if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
    return null;
  }
  if (entry.type === 'message') {
    const lines = messageLines(entry);
    const lastIdx = lines.length - 1;
    const fullLine = lines[lastIdx] ?? '';
    const maxLiveRows = Math.max(3, Math.floor(rows / 3));
    const maxLiveChars = Math.max(columns * maxLiveRows, 200);
    let displayLine = fullLine;
    if (fullLine.length > maxLiveChars) {
      const tail = fullLine.slice(-maxLiveChars);
      // Snap to the next word boundary so we don't display a partial word
      // at the start of the live tail.
      const spaceIdx = tail.indexOf(' ');
      displayLine = spaceIdx >= 0 ? tail.slice(spaceIdx + 1) : tail;
    }
    const isTrulyFirst = lastIdx === 0 && displayLine === fullLine;
    return (
      <AssistantTextLine
        text={displayLine}
        isFirst={isTrulyFirst}
        isStreaming
        width={columns}
      />
    );
  }
  return renderNonMessageEntry(entry, getItemId(entry), callNameMap);
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
  const { stdout } = useStdout();
  // Fallback dimensions keep tests predictable when stdout has no tty.
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

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

  // Determine whether the last entry is still streaming (and therefore
  // must not be fully committed to <Static>).
  const lastEntry = entries[entries.length - 1];
  const hasStreamingEntry =
    status === 'streaming' && lastEntry !== undefined && !isUserEntry(lastEntry);
  const streamingIndex = hasStreamingEntry ? entries.length - 1 : null;
  const streamingEntry = hasStreamingEntry ? lastEntry : null;

  const staticSubItems = useMemo(
    () => buildStaticSubItems(entries, streamingIndex, callNameMap, columns),
    [
      entries,
      streamingIndex,
      callNameMap,
      columns,
    ],
  );

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
        <Static items={staticSubItems}>
          {(item: StaticSubItem) => (
            <Box key={item.key} width={columns}>
              {item.node}
            </Box>
          )}
        </Static>
        {streamingEntry && (
          <Box width={columns}>
            {renderLiveEntry(streamingEntry, callNameMap, columns, rows)}
          </Box>
        )}
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
