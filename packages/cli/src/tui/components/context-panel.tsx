/**
 * Context Split View panel.
 *
 * Renders the live memory-layer / token-usage breakdown alongside the chat.
 * Two render modes:
 *   - 'full'  — bordered box, header + per-layer rows + bars.
 *   - 'strip' — one-line summary used when this pane is the unfocused side
 *               of the narrow stacked layout.
 *
 * The header token count is fed by `useThrottledLiveTokens` (~10 Hz) so it
 * stays responsive without re-rendering on every streamed delta. The per-layer
 * rows update only at turn boundaries from `lastLayerUsage`.
 *
 * See specs/28-context-split-view.md.
 */

import type { LastLayerUsage, MemoryLayer } from '@noetic-tools/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatTokens, getModelContextLimit } from '../../types/model-context.js';
import { buildBar, buildRows } from '../commands/context.js';
import type { LayoutMode } from '../layout/types.js';
import { useThrottledLiveTokens } from '../use-throttled-live-tokens.js';

//#region Types

export interface ContextPanelProps {
  mode: 'full' | 'strip';
  focused: boolean;
  /** Width column count, only meaningful for `mode='full'` in 'wide' layouts. */
  width?: number;
  layoutMode: LayoutMode;
  model: string;
  usage?: LastLayerUsage;
  registeredLayers: ReadonlyArray<MemoryLayer>;
}

//#endregion

//#region Helpers

interface HeaderTokens {
  used: number;
  limit: number;
}

function pickHeaderTokens(
  liveTokens: ReturnType<typeof useThrottledLiveTokens>,
  usage: LastLayerUsage | undefined,
  model: string,
): HeaderTokens {
  if (liveTokens) {
    const used = liveTokens.input + liveTokens.output;
    const limit = getModelContextLimit(model);
    return {
      used,
      limit,
    };
  }
  if (usage) {
    return {
      used: usage.totalUsedTokens,
      limit: getModelContextLimit(usage.modelId),
    };
  }
  return {
    used: 0,
    limit: getModelContextLimit(model),
  };
}

function percent(used: number, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  return (used / limit) * 1e2;
}

//#endregion

//#region Subcomponents

interface PanelHeaderProps {
  used: number;
  limit: number;
  model: string;
}

function PanelHeader({ used, limit, model }: PanelHeaderProps): ReactNode {
  const pct = percent(used, limit);
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={10}>
          <Text dimColor>Model</Text>
        </Box>
        <Text color="cyan">{model}</Text>
      </Box>
      <Box>
        <Box width={10}>
          <Text dimColor>Context</Text>
        </Box>
        <Text>
          <Text color="yellow">{formatTokens(used)}</Text>
          <Text dimColor>
            {' / '}
            {formatTokens(limit)} ({pct.toFixed(1)}%)
          </Text>
        </Text>
      </Box>
    </Box>
  );
}

interface FullModeBodyProps {
  usage: LastLayerUsage | undefined;
}

function FullModeBody({ usage }: FullModeBodyProps): ReactNode {
  if (!usage) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No runs yet — send a message to populate the breakdown.</Text>
      </Box>
    );
  }
  const rows = buildRows(usage);
  const limit = getModelContextLimit(usage.modelId);
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row) => {
        const pct = percent(row.tokens, limit);
        return (
          <Box key={row.label}>
            <Box width={14}>
              <Text color={row.color}>{row.label}</Text>
            </Box>
            <Box width={7}>
              <Text>{formatTokens(row.tokens)}</Text>
            </Box>
            <Text color={row.color}>{buildBar(pct)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

//#endregion

//#region Component

export function ContextPanel(props: ContextPanelProps): ReactNode {
  const { mode, focused, width, layoutMode, model, usage } = props;
  const liveTokens = useThrottledLiveTokens();
  const header = pickHeaderTokens(liveTokens, usage, model);

  if (mode === 'strip') {
    const pct = percent(header.used, header.limit);
    return (
      <Box>
        <Text dimColor={!focused}>
          {focused ? '► ' : '  '}Context · {formatTokens(header.used)} /{' '}
          {formatTokens(header.limit)} ({pct.toFixed(1)}%)
        </Text>
      </Box>
    );
  }

  const titlePrefix = focused ? '► ' : '  ';

  // Wide layout — full-height column separated from chat by a single left
  // border; no top/right/bottom border so the panel reads as a column, not a
  // boxed-in widget.
  if (layoutMode === 'wide') {
    return (
      <Box
        flexDirection="column"
        width={width}
        height="100%"
        borderStyle="single"
        borderColor={focused ? undefined : 'gray'}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold>{titlePrefix}Context</Text>
        <Box height={1} />
        <PanelHeader used={header.used} limit={header.limit} model={model} />
        <FullModeBody usage={usage} />
      </Box>
    );
  }

  // Narrow layout — keep the full bordered box so the focused pane reads as
  // its own region above the collapsed chat strip.
  const borderStyle = focused ? 'round' : 'single';
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={borderStyle}
      borderColor={focused ? undefined : 'gray'}
      paddingX={1}
    >
      <Text bold>{titlePrefix}Context</Text>
      <Box height={1} />
      <PanelHeader used={header.used} limit={header.limit} model={model} />
      <FullModeBody usage={usage} />
    </Box>
  );
}

//#endregion
