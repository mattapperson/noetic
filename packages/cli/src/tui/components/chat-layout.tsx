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

import type { LastLayerUsage, MemoryLayer } from '@noetic-tools/core';
import { Box, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { decideLayoutMode } from '../layout/decide-layout-mode.js';
import { resolvePanelWidth } from '../layout/resolve-panel-width.js';
import type { ContextPanelWidthConfig, Pane } from '../layout/types.js';
import { ContextPanel } from './context-panel.js';

//#region Types

export interface ChatLayoutProps {
  panelOpen: boolean;
  focusedPane: Pane;
  onFocusSwap: () => void;
  panelWidthConfig: ContextPanelWidthConfig;
  modalActive: boolean;
  model: string;
  lastLayerUsage?: LastLayerUsage;
  registeredLayers: ReadonlyArray<MemoryLayer>;
  children: ReactNode;
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
    panelWidthConfig,
    modalActive,
    model,
    lastLayerUsage,
    registeredLayers,
    children,
  } = props;

  const { cols } = useTerminalSize();
  const panelWidth = resolvePanelWidth(cols, panelWidthConfig);
  const layoutMode = decideLayoutMode(cols, panelWidth);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'w') {
        onFocusSwap();
      }
    },
    {
      isActive: panelOpen && !modalActive,
    },
  );

  if (!panelOpen) {
    return <>{children}</>;
  }

  if (layoutMode === 'wide') {
    // The outer RootCanvas is pinned to terminal rows × cols, so
    // `height="100%"` here resolves to the full viewport. The left-bordered
    // context column extends edge-to-edge.
    return (
      <Box flexDirection="row" height="100%">
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
        <ContextPanel
          mode="full"
          focused={focusedPane === 'context'}
          width={panelWidth}
          layoutMode={layoutMode}
          model={model}
          usage={lastLayerUsage}
          registeredLayers={registeredLayers}
        />
      </Box>
    );
  }

  const chatFocused = focusedPane === 'chat';
  return (
    <Box flexDirection="column" height="100%">
      {chatFocused ? (
        <>
          <Box flexDirection="column" flexGrow={1}>
            {children}
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
              layoutMode={layoutMode}
              model={model}
              usage={lastLayerUsage}
              registeredLayers={registeredLayers}
            />
          </Box>
          <Box flexDirection="column">{children}</Box>
        </>
      )}
    </Box>
  );
}

//#endregion
