/**
 * Root TUI application — Ink-rendered interactive agent loop.
 */

import type { AgentHarness, InputMessageItem, Item } from '@noetic/core';
import { render } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

import { createAgentHarness } from '../harness/factory.js';
import type { NoeticPlugin } from '../plugins/types.js';
import type { AgentConfig } from '../types/config.js';
import type { ChatStatus } from './components/index.js';
import { InkProvider, ResponsesChat } from './components/index.js';
import type { ConversationEntry, ErrorEntry, UserEntry } from './item-utils.js';
import { appendOrUpdateEntry, isErrorEntry, isUserEntry } from './item-utils.js';

//#region Helpers

function buildErrorEntry(error: unknown): ErrorEntry {
  return {
    role: 'system',
    type: 'error',
    content: `Error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * Convert a UserEntry to an Item for passing to the harness.
 */
function userEntryToItem(entry: UserEntry): InputMessageItem {
  return {
    id: `user-${Date.now()}`,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text: entry.content,
      },
    ],
  } satisfies InputMessageItem;
}

function isItem(entry: ConversationEntry): entry is Item {
  return 'type' in entry && typeof entry.type === 'string' && entry.type !== 'error';
}

/**
 * Convert conversation entries to Items for the harness.
 * Filters out ErrorEntry since they aren't meaningful conversation context.
 */
function entriesToItems(entries: ConversationEntry[]): Item[] {
  const items: Item[] = [];
  for (const entry of entries) {
    if (isErrorEntry(entry)) {
      continue;
    }
    if (isUserEntry(entry)) {
      items.push(userEntryToItem(entry));
      continue;
    }
    // AssistantEntry is already an Item - use type guard
    if (isItem(entry)) {
      items.push(entry);
    }
  }
  return items;
}

/**
 * Get or create the harness, retrying on failure.
 * Stores the harness directly to avoid race conditions where a rejected
 * promise would cause all subsequent awaits to fail.
 */
async function getOrCreateHarness(
  harnessRef: {
    current: AgentHarness | null;
  },
  config: AgentConfig,
  plugins: ReadonlyArray<NoeticPlugin>,
): Promise<AgentHarness> {
  if (harnessRef.current !== null) {
    return harnessRef.current;
  }
  const harness = await createAgentHarness(config, plugins);
  harnessRef.current = harness;
  return harness;
}

//#endregion

//#region Types

interface AppProps {
  config: AgentConfig;
  plugins: ReadonlyArray<NoeticPlugin>;
}

//#endregion

//#region App Component

function App({ config, plugins }: AppProps): ReactNode {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [status, setStatus] = useState<ChatStatus>('ready');

  const harnessRef = useRef<AgentHarness | null>(null);

  // Use a ref to track entries so we can access current value in the callback
  // without adding entries to the dependency array (which would cause re-renders)
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const handleSubmit = useCallback(
    async (text: string): Promise<void> => {
      const userEntry: UserEntry = {
        role: 'user',
        content: text,
      };
      setEntries((prev) => [
        ...prev,
        userEntry,
      ]);
      setStatus('submitted');

      try {
        const harness = await getOrCreateHarness(harnessRef, config, plugins);
        // Build conversation history including the new user message
        const historyItems = entriesToItems([
          ...entriesRef.current,
          userEntry,
        ]);
        const result = harness.execute(historyItems);
        setStatus('streaming');
        for await (const item of result.getItemStream()) {
          setEntries((prev) => appendOrUpdateEntry(prev, item));
        }
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          buildErrorEntry(error),
        ]);
      } finally {
        setStatus('ready');
      }
    },
    [
      config,
      plugins,
    ],
  );

  return (
    <InkProvider>
      <ResponsesChat
        entries={entries}
        status={status}
        onSubmit={handleSubmit}
        model={config.model}
      />
    </InkProvider>
  );
}

//#endregion

//#region Entry Point

export async function runAgent(
  plugins: ReadonlyArray<NoeticPlugin>,
  config: AgentConfig,
): Promise<void> {
  const { waitUntilExit } = render(<App config={config} plugins={plugins} />);
  await waitUntilExit();
}

//#endregion
