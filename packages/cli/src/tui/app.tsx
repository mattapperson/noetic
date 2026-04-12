/**
 * Root TUI application — Ink-rendered interactive agent loop.
 */

import type { AgentHarness, InputMessageItem, Item } from '@noetic/core';
import { render } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  BUILTIN_COMMANDS,
  commandsToPromptSuggestions,
  executeCommand,
  findCommand,
  isSlashCommand,
  parseSlashCommand,
} from '../commands/index.js';
import type { Command, CommandContext } from '../commands/types.js';
import { createAgentHarness } from '../harness/factory.js';
import type { NoeticPlugin } from '../plugins/types.js';
import type { SkillDefinition } from '../skills/types.js';
import type { AgentConfig } from '../types/config.js';
import type { ChatStatus } from './components/index.js';
import { InkProvider, ResponsesChat } from './components/index.js';
import type { ConversationEntry, ErrorEntry, SystemEntry, UserEntry } from './item-utils.js';
import {
  appendOrUpdateEntry,
  extractActivatedSkills,
  isErrorEntry,
  isUserEntry,
} from './item-utils.js';

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
  const [skills, setSkills] = useState<ReadonlyArray<SkillDefinition>>([]);
  const [commandOutput, setCommandOutput] = useState<ReactNode | null>(null);

  const harnessRef = useRef<AgentHarness | null>(null);

  // Use a ref to track entries so we can access current value in the callback
  // without adding entries to the dependency array (which would cause re-renders)
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Built-in commands only - skills are not slash commands
  const commands = useMemo<Command[]>(
    () => [
      ...BUILTIN_COMMANDS,
    ],
    [],
  );

  // Convert commands to PromptInput format
  const commandSuggestions = useMemo(
    () => commandsToPromptSuggestions(commands),
    [
      commands,
    ],
  );

  // Clear entries callback for /clear command
  const clearEntries = useCallback(() => {
    setEntries([]);
  }, []);

  /**
   * Get or create the harness, storing the canonical skill catalog.
   */
  const getOrCreateHarness = useCallback(async (): Promise<AgentHarness> => {
    if (harnessRef.current !== null) {
      return harnessRef.current;
    }
    const { harness, skills: resolvedSkills } = await createAgentHarness(config, plugins);
    harnessRef.current = harness;
    setSkills(resolvedSkills);
    return harness;
  }, [
    config,
    plugins,
  ]);

  const handleSubmit = useCallback(
    async (text: string): Promise<void> => {
      // Check if this is a slash command
      if (isSlashCommand(text)) {
        const parsed = parseSlashCommand(text);
        if (parsed) {
          const cmd = findCommand(parsed.commandName, commands);
          if (cmd) {
            // Build command context with activated skills from conversation
            const activatedSkills = extractActivatedSkills(entriesRef.current);
            const ctx: CommandContext = {
              config,
              cwd: config.cwd,
              entries: entriesRef.current,
              skills,
              activatedSkills,
              commands,
              clearEntries,
            };

            try {
              const result = await executeCommand(cmd, parsed.args, ctx);
              if (result.type === 'text') {
                // Show text result as info message (not error)
                setEntries((prev) => [
                  ...prev,
                  {
                    role: 'system',
                    type: 'info',
                    content: result.value,
                  } satisfies SystemEntry,
                ]);
              } else if (result.type === 'jsx') {
                // Render JSX output
                setCommandOutput(result.node);
                // Clear after a short delay
                setTimeout(() => setCommandOutput(null), 100);
              }
              // 'skip' type means no output
            } catch (error) {
              setEntries((prev) => [
                ...prev,
                buildErrorEntry(error),
              ]);
            }
            return;
          }
        }
        // Unknown command - show error
        setEntries((prev) => [
          ...prev,
          {
            role: 'system',
            type: 'error',
            content: `Unknown command: ${text}`,
          } satisfies ErrorEntry,
        ]);
        return;
      }

      // Regular message - send to model
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
        const harness = await getOrCreateHarness();
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
      commands,
      skills,
      clearEntries,
      getOrCreateHarness,
    ],
  );

  return (
    <InkProvider>
      {commandOutput}
      <ResponsesChat
        entries={entries}
        status={status}
        onSubmit={handleSubmit}
        model={config.model}
        commands={commandSuggestions}
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
