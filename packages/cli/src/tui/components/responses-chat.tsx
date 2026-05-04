/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Renders each item type with Claude Code-style presentation.
 */

import type { Item } from '@noetic/core';
import { Box, Static, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMode } from '../../harness/factory.js';
import type { NoeticPlugin } from '../../plugins/types.js';
import { collapseReads } from '../grouping/collapse-reads.js';
import type { CollapsedReadGroup, DisplayEntry } from '../grouping/types.js';
import { isCollapsedReadGroup, toStaticEntryItems } from '../grouping/types.js';
import type { ConversationEntry } from '../item-utils.js';
import {
  extractReasoning,
  extractTextContent,
  getItemId,
  isErrorEntry,
  isSystemEntry,
  isUserEntry,
} from '../item-utils.js';
import { previewToolArgs } from '../tool-args-preview.js';
import type { SpinnerMode, ToolCallStatus } from './items/index.js';
import {
  AssistantText,
  BashResult,
  CollapsedReadGroupView,
  EditResult,
  LoadingSpinner,
  LspResult,
  Reasoning,
  SystemMessage,
  ToolCall,
  ToolResult,
  UserPrompt,
} from './items/index.js';
import type { ChatStatus, PromptInputMessage } from './prompt-input.js';
import { PromptInput } from './prompt-input.js';
import type { CallInfo } from './transcript-view.js';
import { TranscriptView } from './transcript-view.js';

//#region Types

export interface ResponsesChatProps {
  entries: ConversationEntry[];
  status: ChatStatus;
  onSubmit: (message: PromptInputMessage) => void;
  onStop?: () => void;
  model?: string;
  agentMode?: AgentMode;
  onToggleMode?: () => void;
  commands?: Array<{
    cmd: string;
    desc?: string;
  }>;
  modalContent?: ReactNode;
  onModalClose?: () => void;
  plugins?: ReadonlyArray<NoeticPlugin>;
  /**
   * When true, a "Press Ctrl+C again to exit" hint is rendered above the
   * prompt for the duration of the double-press window.
   */
  exitHintArmed?: boolean;
  /**
   * Returns the items array that would be sent to the model on the next turn —
   * fetched on demand when the request-items overlay (Ctrl+R) opens.
   */
  getRequestItems?: () => Promise<ReadonlyArray<Item>>;
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
  callInfoMap: Map<string, CallInfo>;
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

function buildCallInfoMap(entries: ConversationEntry[]): Map<string, CallInfo> {
  const info = new Map<string, CallInfo>();
  for (const entry of entries) {
    if (isUserEntry(entry) || isErrorEntry(entry) || isSystemEntry(entry)) {
      continue;
    }
    if (entry.type === 'function_call') {
      info.set(entry.callId, {
        name: entry.name,
        status: mapItemStatus(entry.status),
      });
    }
  }
  return info;
}

function categorize(entry: DisplayEntry): EntryCategory {
  if (isCollapsedReadGroup(entry)) {
    return 'tool-result';
  }
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

function computeCategories(entries: ReadonlyArray<DisplayEntry>): EntryCategory[] {
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

//#region Entry Dispatch

function renderCollapsedGroup(group: CollapsedReadGroup): ReactNode {
  return <CollapsedReadGroupView key={group.id} group={group} />;
}

function renderEntry(entry: DisplayEntry, index: number, ctx: RenderContext): ReactNode {
  const addMargin = shouldAddMargin(ctx.categories, index);

  if (isCollapsedReadGroup(entry)) {
    return renderCollapsedGroup(entry);
  }

  if (isUserEntry(entry)) {
    return (
      <UserPrompt
        key={`user-${entry.id ?? index}`}
        text={entry.content}
        addMargin={addMargin}
        deliveryStatus={entry.deliveryStatus}
      />
    );
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
    const name = entry.name ?? 'tool';
    return (
      <ToolCall
        key={key}
        name={name}
        status={mapItemStatus(entry.status)}
        args={previewToolArgs(name, entry.arguments ?? '')}
        addMargin={addMargin}
      />
    );
  }

  if (entry.type === 'function_call_output') {
    const info = ctx.callInfoMap.get(entry.callId);
    const isError = info?.status === 'error';
    if (info?.name === 'Edit') {
      return <EditResult key={key} output={entry.output} />;
    }
    if (info?.name === 'Bash') {
      return <BashResult key={key} output={entry.output} />;
    }
    if (info?.name === 'lsp') {
      return (
        <LspResult
          key={key}
          output={entry.output}
          isError={isError}
          fallback={<ToolResult output={entry.output} isError={isError} />}
        />
      );
    }
    return <ToolResult key={key} output={entry.output} isError={isError} />;
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
  agentMode,
  onToggleMode,
  commands,
  modalContent,
  onModalClose,
  plugins,
  exitHintArmed,
  getRequestItems,
}: ResponsesChatProps): ReactNode {
  const pluginsList = plugins ?? [];
  const footerPlugin = useMemo(
    () => pluginsList.find((p) => typeof p.footer === 'function'),
    [
      pluginsList,
    ],
  );

  const [loadingPool, setLoadingPool] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    let cancelled = false;
    async function collect(): Promise<void> {
      const pools = await Promise.all(
        pluginsList.map(async (p): Promise<ReadonlyArray<string>> => {
          if (typeof p.loadingMessages !== 'function') {
            return [];
          }
          try {
            return await p.loadingMessages();
          } catch {
            return [];
          }
        }),
      );
      if (cancelled) {
        return;
      }
      setLoadingPool(pools.flat());
    }
    void collect();
    return () => {
      cancelled = true;
    };
  }, [
    pluginsList,
  ]);

  // Bump the turn id when a new turn begins so the spinner message stays stable
  // within a turn but rotates across turns.
  const prevStatusRef = useRef<ChatStatus>(status);
  const [turnId, setTurnId] = useState(0);
  useEffect(() => {
    if (prevStatusRef.current !== 'submitted' && status === 'submitted') {
      setTurnId((n) => n + 1);
    }
    prevStatusRef.current = status;
  }, [
    status,
  ]);

  const spinnerMessage = useMemo<string | undefined>(() => {
    if (loadingPool.length === 0) {
      return undefined;
    }
    const idx = Math.abs(turnId) % loadingPool.length;
    const picked = loadingPool[idx];
    return picked ? `${picked}...` : undefined;
  }, [
    loadingPool,
    turnId,
  ]);
  const callInfoMap = useMemo(
    () => buildCallInfoMap(entries),
    [
      entries,
    ],
  );

  const [overlay, setOverlay] = useState<'none' | 'transcript' | 'request'>('none');
  const overlayOpen = overlay !== 'none';
  const [requestItems, setRequestItems] = useState<ReadonlyArray<Item> | null>(null);
  // null means "not yet fetched for this open"; derived loading state avoids a
  // separate flag that would otherwise always move in lockstep with setRequestItems.
  const requestItemsLoading = overlay === 'request' && requestItems === null;

  // Fetch request items each time the request overlay opens so the user sees
  // the live state (memory layers + history that would feed the next callModel)
  // rather than a stale snapshot from an earlier open.
  useEffect(() => {
    if (overlay !== 'request' || !getRequestItems) {
      return;
    }
    let cancelled = false;
    setRequestItems(null);
    getRequestItems()
      .then((items) => {
        if (cancelled) {
          return;
        }
        setRequestItems(items);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setRequestItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    overlay,
    getRequestItems,
  ]);

  function handleSubmit(msg: PromptInputMessage): void {
    onSubmit(msg);
  }

  useInput(
    (_input, key) => {
      if (key.escape && modalContent && onModalClose) {
        onModalClose();
        return;
      }
      if (key.escape && overlayOpen) {
        setOverlay('none');
        return;
      }
      if (key.ctrl && _input === 'o') {
        setOverlay((prev) => (prev === 'transcript' ? 'none' : 'transcript'));
        return;
      }
      if (key.ctrl && _input === 'r') {
        setOverlay((prev) => (prev === 'request' ? 'none' : 'request'));
        return;
      }
    },
    {
      isActive: !modalContent || overlayOpen,
    },
  );

  const lastEntry = entries[entries.length - 1];
  const hasStreamingEntry =
    status === 'streaming' && lastEntry !== undefined && !isUserEntry(lastEntry);
  const completedEntries = hasStreamingEntry ? entries.slice(0, -1) : entries;
  const streamingEntry = hasStreamingEntry ? lastEntry : null;

  const collapsedCompleted = useMemo<DisplayEntry[]>(
    () => collapseReads(completedEntries),
    [
      completedEntries,
    ],
  );

  const categories = useMemo(() => {
    const all: DisplayEntry[] = streamingEntry
      ? [
          ...collapsedCompleted,
          streamingEntry,
        ]
      : collapsedCompleted;
    return computeCategories(all);
  }, [
    collapsedCompleted,
    streamingEntry,
  ]);

  const ctx: RenderContext = {
    chatStatus: status,
    callInfoMap,
    entryCount: collapsedCompleted.length + (streamingEntry ? 1 : 0),
    categories,
  };

  // Keep the spinner visible for the full lifetime of a streaming turn — even
  // after assistant text starts appearing — so the user sees live progress
  // (elapsed time, tokens, tok/s) rather than a silent-feeling gap while the
  // agent continues to work across tool rounds.
  const showLoadingSpinner = status === 'streaming';

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
    () => toStaticEntryItems(collapsedCompleted),
    [
      collapsedCompleted,
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

  if (overlayOpen) {
    const isRequest = overlay === 'request';
    const overlayEntries: ReadonlyArray<ConversationEntry> = isRequest
      ? (requestItems ?? [])
      : entries;
    return (
      <Box flexDirection="column" height="100%">
        <Box flexDirection="column" flexGrow={1}>
          {isRequest && requestItemsLoading ? (
            <Text dimColor>Loading request items…</Text>
          ) : (
            <TranscriptView
              entries={overlayEntries}
              callInfoByCallId={callInfoMap}
              title={isRequest ? 'Request Items' : 'Transcript'}
              closeHint={
                isRequest ? ' — press ctrl+r or Esc to close' : ' — press ctrl+o or Esc to close'
              }
              highlightItems={isRequest}
            />
          )}
        </Box>
        {exitHintArmed ? (
          <Box>
            <Text dimColor>Press Ctrl+C again to exit</Text>
          </Box>
        ) : null}
        {/* Keyed by overlay so swapping between transcript and request remounts
            ink-text-input — otherwise the toggling keystroke leaks into the field. */}
        <PromptInput
          key={overlay}
          status={status}
          onSubmit={handleSubmit}
          onStop={onStop}
          onModalClose={onModalClose}
          isModalOpen={!!modalContent}
          model={model}
          agentMode={agentMode}
          onToggleMode={onToggleMode}
          commands={commands}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <Static items={staticItems}>
          {(item: { key: string; entry: DisplayEntry; index: number }) => (
            <Box key={item.key}>{renderEntry(item.entry, item.index, ctx)}</Box>
          )}
        </Static>
        {streamingEntry && <Box>{renderEntry(streamingEntry, collapsedCompleted.length, ctx)}</Box>}
        {showLoadingSpinner && <LoadingSpinner mode={spinnerMode} message={spinnerMessage} />}
      </Box>
      {footerPlugin?.footer ? <Box>{footerPlugin.footer()}</Box> : null}
      {exitHintArmed ? (
        <Box>
          <Text dimColor>Press Ctrl+C again to exit</Text>
        </Box>
      ) : null}
      <PromptInput
        status={status}
        onSubmit={handleSubmit}
        onStop={onStop}
        onModalClose={onModalClose}
        isModalOpen={!!modalContent}
        model={model}
        agentMode={agentMode}
        onToggleMode={onToggleMode}
        commands={commands}
      />
    </Box>
  );
}

//#endregion
