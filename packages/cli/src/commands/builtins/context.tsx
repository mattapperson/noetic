import type { Item, LastLayerUsage, LayerUsageEntry, MemoryLayer } from '@noetic/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import type { ScrollableRow } from '../../tui/components/tabs/index.js';
import { ScrollableBox, Tab, Tabs, TabsContext } from '../../tui/components/tabs/index.js';
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
  registeredLayers: ReadonlyArray<MemoryLayer>;
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
const TAB_CONTENT_HEIGHT = 18;
const PREVIEW_CHARS = 80;

export function formatTokens(n: number): string {
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}

export function buildBar(pct: number): string {
  const raw = Math.round((pct / 1e2) * BAR_WIDTH);
  const filled = Math.max(0, Math.min(BAR_WIDTH, raw));
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
}

export function buildRows(usage: LastLayerUsage): BreakdownRow[] {
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

function extractMessageText(item: Item): string {
  if (item.type !== 'message') {
    return '';
  }
  const parts: string[] = [];
  for (const part of item.content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

export function summarizeItem(item: Item): string {
  if (item.type === 'message') {
    const text = extractMessageText(item);
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const preview =
      collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS)}…` : collapsed;
    return `[${item.role}] ${preview}`;
  }
  if (item.type === 'function_call') {
    return `[call] ${item.name}(${item.arguments.slice(0, 40)})`;
  }
  if (item.type === 'function_call_output') {
    return `[output] ${item.output.slice(0, PREVIEW_CHARS)}`;
  }
  if (item.type === 'reasoning') {
    return '[reasoning]';
  }
  return `[${item.type}]`;
}

function hasId(item: Item): item is Item & {
  id: string;
} {
  return 'id' in item && typeof item.id === 'string';
}

function itemToRow(item: Item, index: number): ScrollableRow {
  const key = hasId(item) ? item.id : `item-${index}`;
  return {
    key,
    node: <Text dimColor>{summarizeItem(item)}</Text>,
  };
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

function ContextOverview({ usage }: { usage: LastLayerUsage }): ReactNode {
  const rows = buildRows(usage);
  const total = usage.totalUsedTokens;
  return (
    <Box flexDirection="column">
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
      <Box height={1} />
      {rows.map((row) => (
        <BreakdownRowView key={row.label} row={row} total={total} />
      ))}
      <Box height={1} />
      <Text dimColor>
        Tab/Shift+Tab or ←/→ to switch tabs. ↓ to scroll layer content, ↑ to return to tabs.
      </Text>
    </Box>
  );
}

interface LayerTabProps {
  layerId: string;
  entry: LayerUsageEntry | undefined;
}

function LayerTab({ layerId, entry }: LayerTabProps): ReactNode {
  const { headerFocused } = useContext(TabsContext);
  if (!entry) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">{layerId}</Text>
          <Text dimColor> · inactive on last run</Text>
        </Text>
        <Box height={1} />
        <Text dimColor>
          This layer is registered but did not contribute items on the last LLM call.
        </Text>
        <Text dimColor>
          Some layers (e.g. planMemory) only activate once a corresponding flow has started.
        </Text>
      </Box>
    );
  }
  if (entry.items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">{layerId}</Text>
          <Text dimColor> · {formatTokens(entry.tokenCount)} tokens, no items</Text>
        </Text>
        <Box height={1} />
        <Text dimColor>
          {entry.tokenCount > 0
            ? 'This layer consumed tokens but exposed no items (likely a string-only recall).'
            : 'No items contributed by this layer on the last call.'}
        </Text>
      </Box>
    );
  }
  const rows = entry.items.map((item, index) => itemToRow(item, index));
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">{layerId}</Text>
        <Text dimColor>
          {' '}
          · {entry.items.length} items · {formatTokens(entry.tokenCount)} tokens
        </Text>
      </Text>
      <Box height={1} />
      <ScrollableBox
        rows={rows}
        height={TAB_CONTENT_HEIGHT}
        isFocused={!headerFocused}
        overflowHint="↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · ↑ to tabs"
      />
    </Box>
  );
}

function EmptyState({ model }: { model: string }): ReactNode {
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

function lookupEntry(
  layers: ReadonlyArray<LayerUsageEntry>,
  layerId: string,
): LayerUsageEntry | undefined {
  return layers.find((l) => l.layerId === layerId);
}

export function ContextDisplay({ model, usage, registeredLayers }: ContextDisplayProps): ReactNode {
  if (!usage) {
    return <EmptyState model={model} />;
  }
  const knownIds = new Set(registeredLayers.map((l) => l.id));
  const orphanEntries = usage.layers.filter((l) => !knownIds.has(l.layerId));
  return (
    <Box flexDirection="column" marginY={1}>
      <Tabs title="Context Status" contentHeight={TAB_CONTENT_HEIGHT + 4} navFromContent={true}>
        <Tab title="Overview" id="__overview">
          <ContextOverview usage={usage} />
        </Tab>
        {registeredLayers.map((layer) => (
          <Tab key={layer.id} title={layer.id} id={layer.id}>
            <LayerTab layerId={layer.id} entry={lookupEntry(usage.layers, layer.id)} />
          </Tab>
        ))}
        {orphanEntries.map((entry) => (
          <Tab key={entry.layerId} title={entry.layerId} id={entry.layerId}>
            <LayerTab layerId={entry.layerId} entry={entry} />
          </Tab>
        ))}
      </Tabs>
    </Box>
  );
}

//#endregion

//#region Implementation

const call: LocalJsxCommandCall = async (_onDone, ctx, _args) => {
  return (
    <ContextDisplay
      model={ctx.config.model}
      usage={ctx.lastLayerUsage}
      registeredLayers={ctx.memoryLayers}
    />
  );
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
