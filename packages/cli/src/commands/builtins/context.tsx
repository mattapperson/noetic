/**
 * /context command - Shows per-memory-layer breakdown of the agent's
 * context window from the most recent run.
 */

import type { LastLayerUsage } from '@noetic/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { Command, LocalJsxCommandCall } from '../types.js';

//#region Types

type RowColor = 'magenta' | 'blue' | 'cyan' | 'green';

interface BreakdownRow {
  label: string;
  tokens: number;
  color: RowColor;
}

interface ContextDisplayProps {
  model: string;
  usage?: LastLayerUsage;
}

interface BreakdownRowViewProps {
  row: BreakdownRow;
  total: number;
}

//#endregion

//#region Helpers

const BAR_WIDTH = 24;
const FILLED = '█';
const EMPTY = '░';

function formatTokens(n: number): string {
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}

function buildBar(pct: number): string {
  const filled = Math.round((pct / 1e2) * BAR_WIDTH);
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

function buildRows(usage: LastLayerUsage): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  if (usage.systemPromptTokens > 0) {
    rows.push({
      label: 'System prompt',
      tokens: usage.systemPromptTokens,
      color: 'magenta',
    });
  }
  if (usage.toolsTokens > 0) {
    rows.push({
      label: 'Tools',
      tokens: usage.toolsTokens,
      color: 'blue',
    });
  }
  for (const layer of usage.layers) {
    rows.push({
      label: layer.layerId,
      tokens: layer.tokenCount,
      color: 'cyan',
    });
  }
  if (usage.historyTokens > 0) {
    rows.push({
      label: 'Messages',
      tokens: usage.historyTokens,
      color: 'green',
    });
  }
  return rows;
}

//#endregion

//#region Components

function BreakdownRowView({ row, total }: BreakdownRowViewProps): ReactNode {
  const pct = total > 0 ? (row.tokens / total) * 1e2 : 0;
  return (
    <Box>
      <Box width={18}>
        <Text color={row.color}>{row.label}</Text>
      </Box>
      <Box width={8}>
        <Text>{formatTokens(row.tokens)}</Text>
      </Box>
      <Box width={7}>
        <Text dimColor>{pct.toFixed(1)}%</Text>
      </Box>
      <Text color={row.color}>{buildBar(pct)}</Text>
    </Box>
  );
}

function ContextDisplay({ model, usage }: ContextDisplayProps): ReactNode {
  if (!usage) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text bold>Context Status</Text>
        <Box height={1} />
        <Box marginLeft={2}>
          <Text dimColor>Model: {model}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>No runs yet — send a message to populate the breakdown.</Text>
        </Box>
      </Box>
    );
  }

  const rows = buildRows(usage);
  const total = usage.totalUsedTokens;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Context Status</Text>
      <Box height={1} />
      <Box marginLeft={2} flexDirection="column">
        <Box>
          <Box width={18}>
            <Text dimColor>Model</Text>
          </Box>
          <Text color="cyan">{usage.modelId}</Text>
        </Box>
        <Box>
          <Box width={18}>
            <Text dimColor>Total used</Text>
          </Box>
          <Text color="yellow">{formatTokens(total)} tokens</Text>
        </Box>
      </Box>
      <Box height={1} />
      <Box marginLeft={2} flexDirection="column">
        {rows.map((row) => (
          <BreakdownRowView key={row.label} row={row} total={total} />
        ))}
      </Box>
      <Box height={1} />
      <Box marginLeft={2}>
        <Text dimColor>
          Token counts are estimates (~4 chars/token). Layer attribution covers items rendered via
          memory-layer recall.
        </Text>
      </Box>
    </Box>
  );
}

//#endregion

//#region Implementation

const call: LocalJsxCommandCall = async (_onDone, ctx, _args) => {
  return <ContextDisplay model={ctx.config.model} usage={ctx.lastLayerUsage} />;
};

//#endregion

//#region Command Definition

export const context: Command = {
  type: 'local-jsx',
  name: 'context',
  description: 'Show context window breakdown by memory layer (from last run)',
  load: async () => ({
    call,
  }),
};

//#endregion
