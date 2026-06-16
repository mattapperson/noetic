/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Renders each item type with Claude Code-style presentation.
 */

import type { Item } from '@noetic-tools/core';
import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMode } from '../../harness/factory.js';
import type { NoeticPlugin } from '../../plugins/types.js';
import { collapseReads } from '../grouping/collapse-reads.js';
import { estimateEntryHeight } from '../grouping/estimate-entry-height.js';
import type { DisplayEntry } from '../grouping/types.js';
import { staticKeyFor } from '../grouping/types.js';
import type { ConversationEntry } from '../item-utils.js';
import { isErrorEntry, isSystemEntry, isUserEntry } from '../item-utils.js';
import { ChatScroll } from './chat-scroll.js';
import type { SpinnerMode } from './items/loading-spinner.js';
import { LoadingSpinner } from './items/loading-spinner.js';
import type { RenderEntryCtx } from './items/render-entry.js';
import { buildCallInfoMap, computeCategories, renderEntry } from './items/render-entry.js';
import type { ChatStatus, PromptInputMessage } from './prompt-input.js';
import { PromptInput } from './prompt-input.js';
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
   * When true, a "Press Ctrl+C again to exit" hint is rendered below the
   * prompt for the duration of the double-press window.
   */
  exitHintArmed?: boolean;
  /**
   * Overlay state owned by `ChatLayout`. `ResponsesChat` is purely controlled
   * here: it renders the transcript / request overlay when `overlay !==
   * 'none'`, but does not own the toggle keys, the open/close transitions, or
   * the request-items fetch.
   */
  overlay?: 'none' | 'transcript' | 'request';
  /** Items sent to the model on the next turn, fetched by ChatLayout. */
  requestItems?: ReadonlyArray<Item> | null;
  /** True while the request overlay is open and items have not yet arrived. */
  requestItemsLoading?: boolean;
  /**
   * When false, the chat pane is not the focused side of the Context Split
   * View. The prompt stops consuming keystrokes, but the chat tree continues
   * to render live updates. Defaults to true.
   */
  isActive?: boolean;
  /**
   * Transient one-line status notice rendered directly below the prompt.
   * Used for ephemeral UI confirmations ("dock opened", "mode switched")
   * that don't belong in the chat scroll. `null` hides the line.
   */
  statusNotice?: string | null;
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
  overlay = 'none',
  requestItems = null,
  requestItemsLoading = false,
  isActive = true,
  statusNotice,
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

  // Overlay state is owned by `ChatLayout` and arrives via props. The toggle
  // keys (Ctrl+O / Ctrl+R) and Esc-closes-overlay live there too — the only
  // useInput we still need locally is the modal Esc, which has higher
  // precedence than any of ChatLayout's chords (it's gated on `modalActive`).
  const overlayOpen = overlay !== 'none';

  function handleSubmit(msg: PromptInputMessage): void {
    onSubmit(msg);
  }

  useInput(
    (_input, key) => {
      if (key.escape && modalContent && onModalClose) {
        onModalClose();
      }
    },
    {
      isActive,
    },
  );

  const collapsedEntries = useMemo<DisplayEntry[]>(
    () => collapseReads(entries),
    [
      entries,
    ],
  );

  const categories = useMemo(
    () => computeCategories(collapsedEntries),
    [
      collapsedEntries,
    ],
  );

  // `ctx` and the two ChatScroll callbacks below are memoised so a state
  // change inside ChatScroll (a scroll tick, for example) doesn't bust the
  // `entryNodes` memo it keeps over its child list. Without these, every
  // line of scroll re-builds the whole entry tree.
  const ctx: RenderEntryCtx = useMemo(
    () => ({
      chatStatus: status,
      callInfoMap,
      entryCount: collapsedEntries.length,
      categories,
    }),
    [
      status,
      callInfoMap,
      collapsedEntries.length,
      categories,
    ],
  );
  const chatScrollRenderEntry = useCallback(
    (entry: DisplayEntry, i: number) => renderEntry(entry, i, ctx),
    [
      ctx,
    ],
  );
  const chatScrollKeyFor = useCallback(
    (entry: DisplayEntry, i: number) => staticKeyFor(entry, i),
    [],
  );

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
                isRequest ? ' — press ctrl+t or Esc to close' : ' — press ctrl+o or Esc to close'
              }
              highlightItems={isRequest}
            />
          )}
        </Box>
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
          isActive={isActive}
        />
        {exitHintArmed ? (
          <Box flexShrink={0}>
            <Text dimColor>Press Ctrl+C again to exit</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <ChatScroll<DisplayEntry>
        entries={collapsedEntries}
        keyFor={chatScrollKeyFor}
        renderEntry={chatScrollRenderEntry}
        heightFor={estimateEntryHeight}
        trailing={
          showLoadingSpinner ? <LoadingSpinner mode={spinnerMode} message={spinnerMessage} /> : null
        }
        trailingHeight={showLoadingSpinner ? 1 : 0}
        isActive={isActive}
      />
      {footerPlugin?.footer ? <Box>{footerPlugin.footer()}</Box> : null}
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
        isActive={isActive}
      />
      {exitHintArmed ? (
        <Box flexShrink={0}>
          <Text dimColor>Press Ctrl+C again to exit</Text>
        </Box>
      ) : null}
      {statusNotice ? (
        <Box flexShrink={0}>
          <Text dimColor>{statusNotice}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion
