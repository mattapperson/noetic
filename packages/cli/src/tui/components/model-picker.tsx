/**
 * Model picker modal — shown by the `/model` command.
 *
 * Renders a filterable, scrollable list of OpenRouter models keyed by their
 * slug (e.g. `anthropic/claude-sonnet-4`). Keyboard contract:
 *   - Arrow Up/Down: move selection
 *   - Type: filter by slug or display name
 *   - Backspace: edit filter
 *   - Enter: select the focused model
 *   - Esc: cancel
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { OpenRouterModel } from '../../ai/openrouter-models.js';
import { fetchOpenRouterModels } from '../../ai/openrouter-models.js';
import { useTheme } from './theme.js';

//#region Types

export interface ModelPickerProps {
  /** Currently-active model slug (marks the row and starts the cursor there). */
  currentModel: string;
  /** Called when the user confirms a selection. */
  onSelect: (modelId: string) => void;
  /** Called when the user cancels (Esc). */
  onCancel: () => void;
}

type LoadState =
  | {
      kind: 'loading';
    }
  | {
      kind: 'error';
      message: string;
    }
  | {
      kind: 'ready';
      models: ReadonlyArray<OpenRouterModel>;
    };

//#endregion

//#region Helpers

const VISIBLE_ROWS = 10;

function formatContext(n: number): string {
  if (n <= 0) {
    return '?';
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${Math.round(n / 1e3)}k`;
  }
  return String(n);
}

function formatPrice(pricePerToken: number): string {
  if (pricePerToken <= 0) {
    return '';
  }
  const perMillion = pricePerToken * 1e6;
  if (perMillion >= 1) {
    return `$${perMillion.toFixed(2)}/M`;
  }
  return `$${perMillion.toFixed(3)}/M`;
}

function matchesFilter(model: OpenRouterModel, filter: string): boolean {
  if (filter.length === 0) {
    return true;
  }
  const needle = filter.toLowerCase();
  return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle);
}

function buildVisibleWindow<T>(
  items: ReadonlyArray<T>,
  cursor: number,
  size: number,
): {
  start: number;
  end: number;
} {
  if (items.length <= size) {
    return {
      start: 0,
      end: items.length,
    };
  }
  const half = Math.floor(size / 2);
  let start = Math.max(0, cursor - half);
  const end = Math.min(items.length, start + size);
  start = Math.max(0, end - size);
  return {
    start,
    end,
  };
}

//#endregion

//#region Subviews

interface RowProps {
  model: OpenRouterModel;
  isFocused: boolean;
  isCurrent: boolean;
}

function ModelRow({ model, isFocused, isCurrent }: RowProps): ReactNode {
  const theme = useTheme();
  const marker = isFocused ? '❯ ' : '  ';
  const ctx = formatContext(model.contextLength);
  const price = formatPrice(model.promptPrice);
  const suffix = price.length > 0 ? ` · ${ctx} · ${price}` : ` · ${ctx}`;
  const color = isFocused ? theme.primary : isCurrent ? theme.accent : theme.foreground;
  const currentTag = isCurrent ? ' (current)' : '';
  return (
    <Box>
      <Text color={color}>{marker}</Text>
      <Text color={color} bold={isFocused}>
        {model.id}
      </Text>
      <Text dimColor>{suffix}</Text>
      {isCurrent ? <Text color={theme.success}>{currentTag}</Text> : null}
    </Box>
  );
}

function LoadingView(): ReactNode {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.muted}>Fetching model list from OpenRouter…</Text>
    </Box>
  );
}

function ErrorView({ message }: { message: string }): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.error}>Failed to load models: {message}</Text>
      <Text dimColor>Press Esc to close.</Text>
    </Box>
  );
}

//#endregion

//#region Component

export function ModelPicker({ currentModel, onSelect, onCancel }: ModelPickerProps): ReactNode {
  const theme = useTheme();
  const [state, setState] = useState<LoadState>({
    kind: 'loading',
  });
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const models = await fetchOpenRouterModels();
        if (cancelled) {
          return;
        }
        setState({
          kind: 'ready',
          models,
        });
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({
          kind: 'error',
          message,
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo<ReadonlyArray<OpenRouterModel>>(() => {
    if (state.kind !== 'ready') {
      return [];
    }
    return state.models.filter((m) => matchesFilter(m, filter));
  }, [
    state,
    filter,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready') {
      return;
    }
    const idx = state.models.findIndex((m) => m.id === currentModel);
    setCursor(idx >= 0 ? idx : 0);
  }, [
    state,
    currentModel,
  ]);

  useEffect(() => {
    if (filter.length > 0) {
      setCursor(0);
    }
  }, [
    filter,
  ]);

  const clampedCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (state.kind !== 'ready') {
      return;
    }
    if (key.return) {
      const picked = filtered[clampedCursor];
      if (picked) {
        onSelect(picked.id);
      }
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
      return;
    }
    if (key.pageUp) {
      setCursor((c) => Math.max(0, c - VISIBLE_ROWS));
      return;
    }
    if (key.pageDown) {
      setCursor((c) => Math.min(filtered.length - 1, c + VISIBLE_ROWS));
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
    }
  });

  const visibleWindow = useMemo(
    () => buildVisibleWindow(filtered, clampedCursor, VISIBLE_ROWS),
    [
      filtered,
      clampedCursor,
    ],
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} padding={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color={theme.primary}>
          Select model
        </Text>
        <Text dimColor>
          Switch the active OpenRouter model for this session. Type to filter by slug or name.
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={theme.muted}>filter: </Text>
        <Text color={theme.foreground}>{filter}</Text>
        <Text color={theme.muted}>█</Text>
      </Box>

      {state.kind === 'loading' ? <LoadingView /> : null}
      {state.kind === 'error' ? <ErrorView message={state.message} /> : null}

      {state.kind === 'ready' ? (
        <Box flexDirection="column" marginBottom={1}>
          {filtered.length === 0 ? (
            <Text dimColor>No models match "{filter}"</Text>
          ) : (
            <>
              {visibleWindow.start > 0 ? (
                <Text dimColor> ↑ {visibleWindow.start} more above</Text>
              ) : null}
              {filtered.slice(visibleWindow.start, visibleWindow.end).map((model, i) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isFocused={visibleWindow.start + i === clampedCursor}
                  isCurrent={model.id === currentModel}
                />
              ))}
              {visibleWindow.end < filtered.length ? (
                <Text dimColor> ↓ {filtered.length - visibleWindow.end} more below</Text>
              ) : null}
            </>
          )}
        </Box>
      ) : null}

      <Box>
        <Text color={theme.success}>[Enter] select</Text>
        <Text>{'  '}</Text>
        <Text color={theme.error}>[Esc] cancel</Text>
        <Text>{'  '}</Text>
        <Text dimColor>↑/↓ navigate · PgUp/PgDn jump · type to filter</Text>
      </Box>
    </Box>
  );
}

//#endregion
