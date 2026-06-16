/**
 * Wrapping layout for the chat view when the Context Split View dock is open.
 *
 *  - Computes terminal-aware panel width and chooses wide/narrow layout.
 *  - Owns the single Ctrl+W binding that swaps focus between chat and context.
 *  - Renders ResponsesChat plus a ContextPanel (full or strip) according to
 *    layoutMode × focusedPane.
 *
 * State (`panelOpen`, `focusedPane`) lives in app.tsx because the `/context`
 * slash command needs to toggle it. ChatLayout is a pure renderer.
 *
 * See specs/28-context-split-view.md.
 */

import type { Item, LastLayerUsage, MemoryLayer } from '@noetic-tools/core';
import { Box, Text, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { ChatStatus } from '../chat-status.js';
import type { ConversationEntry } from '../item-utils.js';
import { decideLayoutMode } from '../layout/decide-layout-mode.js';
import { resolvePanelWidth } from '../layout/resolve-panel-width.js';
import { buildTitleBar } from '../layout/title-bar.js';
import type { ContextPanelWidthConfig, Pane } from '../layout/types.js';
import { ChatStrip } from './chat-strip.js';
import { ContextPanel } from './context-panel.js';

//#region Types

export type OverlayKind = 'none' | 'transcript' | 'request';

/**
 * Snapshot of the overlay state ChatLayout owns and passes down to
 * `ResponsesChat` for rendering. ResponsesChat is purely controlled with
 * respect to overlays — it does not own the toggle keys or the fetch.
 */
export interface OverlayState {
  overlay: OverlayKind;
  requestItems: ReadonlyArray<Item> | null;
  requestItemsLoading: boolean;
}

export interface ChatLayoutProps {
  panelOpen: boolean;
  focusedPane: Pane;
  onFocusSwap: () => void;
  onClosePanel: () => void;
  panelWidthConfig: ContextPanelWidthConfig;
  modalActive: boolean;
  model: string;
  lastLayerUsage?: LastLayerUsage;
  registeredLayers: ReadonlyArray<MemoryLayer>;
  /**
   * Fetches the items that would be sent to the model on the next turn. Run
   * each time the request overlay opens so the user sees the live state
   * rather than a stale snapshot.
   */
  getRequestItems?: () => Promise<ReadonlyArray<Item>>;
  /**
   * Conversation entries — required so the narrow-mode `ChatStrip` (which
   * replaces the full chat when the user focuses the context pane) can
   * derive its message-count summary and the streaming-delta tail preview.
   * Treated as read-only at this layer.
   */
  entries: ReadonlyArray<ConversationEntry>;
  /** Chat status — used by `ChatStrip` to swap idle / streaming summaries. */
  status: ChatStatus;
  /**
   * Receives the current overlay snapshot. The presentational chat surface
   * (`ResponsesChat`) takes this in as props and renders the transcript /
   * request overlay accordingly. Wrapped as a render-prop so ChatLayout owns
   * the state without forcing callers to plumb it.
   */
  children: (overlay: OverlayState) => ReactNode;
}

//#endregion

//#region Hooks

interface TerminalSize {
  cols: number;
  rows: number;
}

function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    cols: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) {
      return;
    }
    const handler = (): void => {
      setSize({
        cols: stdout.columns,
        rows: stdout.rows,
      });
    };
    stdout.on('resize', handler);
    return (): void => {
      stdout.off('resize', handler);
    };
  }, [
    stdout,
  ]);
  return size;
}

//#endregion

//#region Component

export function ChatLayout(props: ChatLayoutProps): ReactNode {
  const {
    panelOpen,
    focusedPane,
    onFocusSwap,
    onClosePanel,
    panelWidthConfig,
    modalActive,
    model,
    lastLayerUsage,
    registeredLayers,
    getRequestItems,
    entries,
    status,
    children,
  } = props;

  const { cols } = useTerminalSize();
  const panelWidth = resolvePanelWidth(cols, panelWidthConfig);
  const layoutMode = decideLayoutMode(cols, panelWidth);

  // Overlay state (transcript / request) lives here, not in ResponsesChat,
  // so the toggle keys (Ctrl+O / Ctrl+R) stay live regardless of which pane
  // has focus. ResponsesChat receives the snapshot via the render-prop
  // children and renders accordingly.
  const [overlay, setOverlay] = useState<OverlayKind>('none');
  const [requestItems, setRequestItems] = useState<ReadonlyArray<Item> | null>(null);
  const overlayOpen = overlay !== 'none';
  const requestItemsLoading = overlay === 'request' && requestItems === null;

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
    return (): void => {
      cancelled = true;
    };
  }, [
    overlay,
    getRequestItems,
  ]);

  useInput(
    (input, key) => {
      // Ctrl+W swaps focus, but only when the dock is open (otherwise there
      // is no second pane to swap to).
      if (key.ctrl && input === 'w' && panelOpen) {
        onFocusSwap();
        return;
      }
      if (key.ctrl && input === 'o') {
        setOverlay((prev) => (prev === 'transcript' ? 'none' : 'transcript'));
        return;
      }
      // Ctrl+T (Toggle request-items) opens the next-turn preview. Moved off
      // Ctrl+R because that chord is now claimed by prompt-history reverse
      // search (matches readline / bash convention).
      if (key.ctrl && input === 't') {
        setOverlay((prev) => (prev === 'request' ? 'none' : 'request'));
        return;
      }
      if (key.escape) {
        // Precedence: an open overlay closes first, then the dock. Modal
        // Esc is handled inside ResponsesChat (modalActive gates this
        // listener off entirely when a modal is up).
        if (overlayOpen) {
          setOverlay('none');
          return;
        }
        if (panelOpen) {
          onClosePanel();
        }
      }
    },
    {
      isActive: !modalActive,
    },
  );

  const overlayState: OverlayState = {
    overlay,
    requestItems,
    requestItemsLoading,
  };
  const renderedChildren = children(overlayState);

  if (!panelOpen) {
    return <>{renderedChildren}</>;
  }

  const chatFocused = focusedPane === 'chat';

  if (layoutMode === 'wide') {
    // Two columns. Each has a top title bar (`─ ► chat ─` / `─ ► Context ─`)
    // and content below. The vertical divider between them is rendered by
    // the context panel's left border. No right / bottom borders anywhere —
    // the chrome is intentionally minimal.
    const chatWidth = Math.max(0, cols - panelWidth);
    return (
      <Box flexDirection="row" height="100%">
        <Box flexDirection="column" width={chatWidth} height="100%">
          <Text bold={chatFocused} dimColor={!chatFocused}>
            {buildTitleBar(chatWidth, chatFocused, 'chat')}
          </Text>
          <Box flexDirection="column" flexGrow={1}>
            {renderedChildren}
          </Box>
        </Box>
        <ContextPanel
          mode="full"
          focused={!chatFocused}
          width={panelWidth}
          layoutMode={layoutMode}
          model={model}
          usage={lastLayerUsage}
          registeredLayers={registeredLayers}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      {chatFocused ? (
        <>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold dimColor={false}>
              {buildTitleBar(cols, true, 'chat')}
            </Text>
            {renderedChildren}
          </Box>
          <ContextPanel
            mode="strip"
            focused={false}
            layoutMode={layoutMode}
            model={model}
            usage={lastLayerUsage}
            registeredLayers={registeredLayers}
          />
        </>
      ) : (
        <>
          <Box flexDirection="column" flexGrow={1}>
            <ContextPanel
              mode="full"
              focused={true}
              width={cols}
              layoutMode={layoutMode}
              model={model}
              usage={lastLayerUsage}
              registeredLayers={registeredLayers}
            />
          </Box>
          {/*
            The chat side collapses to a strip so the panel can fill the
            viewport. ChatStrip handles the streaming-delta tail preview
            internally; the prompt is intentionally NOT rendered here (the
            user is interacting with the context pane, not typing).
          */}
          <Box flexDirection="column">
            <Text dimColor>{buildTitleBar(cols, false, 'chat')}</Text>
            <ChatStrip entries={entries} status={status} width={cols} />
          </Box>
        </>
      )}
    </Box>
  );
}

//#endregion
