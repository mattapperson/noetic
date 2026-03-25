/**
 * Root TUI application — Gridland-rendered interactive agent loop.
 */

import { createCliRenderer, createRoot, useKeyboard } from '@gridland/bun';
import type { OpenRouter } from '@openrouter/sdk';
import { stepCountIs } from '@openrouter/sdk';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';
import { buildSystemPrompt } from '../ai/system-prompt.js';
import { createCodingTools } from '../tools/index.js';
import type { AgentConfig } from '../types/config.js';
import type { ChatStatus } from './components/index.js';
import { GridlandProvider, ResponsesChat } from './components/index.js';
import type { ConversationEntry, UserEntry } from './item-utils.js';
import { appendOrUpdateEntry, isUserEntry } from './item-utils.js';

//#region Types

interface AppProps {
  client: OpenRouter;
  config: AgentConfig;
}

//#endregion

//#region Helpers

function entriesToCallModelInput(entries: ConversationEntry[]): Array<
  | {
      role: 'user';
      content: string;
    }
  | ConversationEntry
> {
  return entries.map((entry) => {
    if (isUserEntry(entry)) {
      return {
        role: 'user' as const,
        content: entry.content,
      };
    }
    return entry;
  });
}

//#endregion

//#region App Component

function App({ client, config }: AppProps): ReactNode {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [status, setStatus] = useState<ChatStatus>('ready');

  const toolsRef = useRef(createCodingTools(config.cwd));
  const systemPromptRef = useRef(config.systemPrompt ?? buildSystemPrompt(config.cwd));
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

      const input = entriesToCallModelInput([
        ...entriesRef.current,
        userEntry,
      ]);

      const result = client.callModel({
        model: config.model,
        instructions: systemPromptRef.current,
        input,
        tools: toolsRef.current,
        stopWhen: [
          stepCountIs(config.maxTurns),
        ],
      });

      try {
        let firstItem = true;

        for await (const item of result.getItemsStream()) {
          if (firstItem) {
            setStatus('streaming');
            firstItem = false;
          }
          setEntries((prev) => appendOrUpdateEntry(prev, item));
        }
      } finally {
        setStatus('ready');
      }
    },
    [
      client,
      config.model,
      config.maxTurns,
    ],
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

export async function runAgent(client: OpenRouter, config: AgentConfig): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });
  createRoot(renderer).render(<App client={client} config={config} />);
}

//#endregion
