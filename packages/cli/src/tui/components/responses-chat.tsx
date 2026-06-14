/**
 * OpenResponses-native chat component.
 *
 * Accepts StreamableOutputItem directly from callModel — no adapter types.
 * Renders each item type with Claude Code-style presentation.
 */

import type { Item } from '@noetic-tools/core';
import { Box, Static, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMode } from '../../harness/factory.js';
import type { NoeticPlugin } from '../../plugins/types.js';
import { collapseReads } from '../grouping/collapse-reads.js';
import { splitStaticEntries } from '../grouping/split-static-entries.js';
import type { DisplayEntry } from '../grouping/types.js';
import { staticKeyFor, toStaticEntryItems } from '../grouping/types.js';
import type { ConversationEntry } from '../item-utils.js';
import { isErrorEntry, isSystemEntry, isUserEntry } from '../item-utils.js';
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

  useInput((_input, key) => {
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
  });

  const collapsedEntries = useMemo<DisplayEntry[]>(
    () => collapseReads(entries),
    [
      entries,
    ],
  );

  // Frozen prefix goes into <Static> (rendered once, flushed to scrollback);
  // the still-mutable suffix re-renders live. See split-static-entries.ts
  // for what counts as still-mutable.
  const { staticEntries, liveEntries } = useMemo(
    () => splitStaticEntries(collapsedEntries, status),
    [
      collapsedEntries,
      status,
    ],
  );

  const categories = useMemo(
    () => computeCategories(collapsedEntries),
    [
      collapsedEntries,
    ],
  );

  const ctx: RenderEntryCtx = {
    chatStatus: status,
    callInfoMap,
    entryCount: collapsedEntries.length,
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
    () => toStaticEntryItems(staticEntries),
    [
      staticEntries,
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
        {liveEntries.map((entry, i) => (
          <Box key={staticKeyFor(entry, staticEntries.length + i)}>
            {renderEntry(entry, staticEntries.length + i, ctx)}
          </Box>
        ))}
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
