/**
 * Context Split View panel.
 *
 * Renders the per-turn memory-layer / token-usage breakdown alongside the
 * chat. Two render modes:
 *   - 'full'  — bordered box, header + per-layer rows + bars.
 *   - 'strip' — one-line summary used when this pane is the unfocused side
 *               of the narrow stacked layout.
 *
 * Header total and per-layer rows both read from `lastLayerUsage` — a single
 * authoritative source committed at turn boundaries by the stream consumer.
 * No mid-turn ticking: a streamed delta does NOT update the header. Keeping
 * the header and the bars in lockstep beats a flickering counter that
 * disagrees with the rows beneath it.
 *
 * See specs/28-context-split-view.md.
 */

import type { LastLayerUsage, MemoryLayer } from '@noetic-tools/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatTokens, getModelContextLimit } from '../../types/model-context.js';
import { buildBar, buildRows } from '../commands/context.js';
import { buildTitleBar } from '../layout/title-bar.js';
import type { LayoutMode } from '../layout/types.js';

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

function pickHeaderTokens(usage: LastLayerUsage | undefined, model: string): HeaderTokens {
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
        <Box flexGrow={1} flexShrink={1}>
          <Text color="cyan" wrap="truncate-middle">
            {model}
          </Text>
        </Box>
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
              <Text color={row.color} wrap="truncate-end">
                {row.label}
              </Text>
            </Box>
            <Box width={7}>
              <Text wrap="truncate">{formatTokens(row.tokens)}</Text>
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
  const header = pickHeaderTokens(usage, model);

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

  // Chrome model: single top horizontal rule with inline title; in wide mode
  // the column is separated from chat by a left `│` divider. No right /
  // bottom borders, no full box. Focus is signalled by the `►` glyph + bold
  // title (the rule itself stays the same character either way, so swapping
  // focus never visibly redraws the chrome).
  const titleBarWidth = width ?? 0;
  const titleBar = buildTitleBar(titleBarWidth, focused, 'Context');

  if (layoutMode === 'wide') {
    return (
      <Box flexDirection="column" width={width} height="100%">
        <Text bold={focused} dimColor={!focused}>
          {titleBar}
        </Text>
        <Box
          flexDirection="row"
          flexGrow={1}
          borderStyle="single"
          borderColor={focused ? undefined : 'gray'}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          <Box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
            <PanelHeader used={header.used} limit={header.limit} model={model} />
            <FullModeBody usage={usage} />
          </Box>
        </Box>
      </Box>
    );
  }

  // Narrow layout — top rule only, no side dividers. Below the rule we keep
  // a light horizontal padding so the content doesn't sit flush against the
  // terminal edge.
  return (
    <Box flexDirection="column" width={width}>
      <Text bold={focused} dimColor={!focused}>
        {titleBar}
      </Text>
      <Box flexDirection="column" paddingX={1}>
        <PanelHeader used={header.used} limit={header.limit} model={model} />
        <FullModeBody usage={usage} />
      </Box>
    </Box>
  );
}

//#endregion
