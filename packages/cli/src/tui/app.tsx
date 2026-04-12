/**
 * Root TUI application — Gridland-rendered interactive agent loop.
 */

import { createCliRenderer, createRoot, useKeyboard } from '@gridland/bun';
import type { HarnessResult, Item } from '@noetic/core';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

import { createAgentHarness } from '../harness/factory.js';
import type { NoeticPlugin } from '../plugins/types.js';
import type { AgentConfig } from '../types/config.js';
import type { ChatStatus } from './components/index.js';
import { GridlandProvider, ResponsesChat } from './components/index.js';
import type { ConversationEntry, UserEntry } from './item-utils.js';
import { appendOrUpdateEntry } from './item-utils.js';

//#region Helpers

function buildErrorEntry(error: unknown): UserEntry {
  return {
    role: 'user',
    content: `Error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

async function collectItems(result: HarnessResult): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of result.getItemStream()) {
    items.push(item);
  }
  return items;
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

  const harnessPromiseRef = useRef(createAgentHarness(config, plugins));

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
        const harness = await harnessPromiseRef.current;
        const result = harness.execute(text);
        setStatus('streaming');
        const items = await collectItems(result);
        setEntries((prev) => {
          let nextEntries = [
            ...prev,
          ];
          for (const item of items) {
            nextEntries = appendOrUpdateEntry(nextEntries, item);
          }
          return nextEntries;
        });
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          buildErrorEntry(error),
        ]);
      } finally {
        setStatus('ready');
      }
    },
    [config, plugins],
  );

  return (
    <GridlandProvider useKeyboard={useKeyboard}>
      <ResponsesChat
        entries={entries}
        status={status}
        onSubmit={handleSubmit}
        model={config.model}
      />
    </GridlandProvider>
  );
}

//#endregion

//#region Entry Point

export async function runAgent(
  plugins: ReadonlyArray<NoeticPlugin>,
  config: AgentConfig,
): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });
  createRoot(renderer).render(<App config={config} plugins={plugins} />);
}

//#endregion
