/**
 * Root TUI application — Ink-rendered interactive agent loop.
 */

import type {
  AgentHarness,
  InputMessageItem,
  Item,
  LastLayerUsage,
  MemoryLayer,
  PlanState,
} from '@noetic/core';
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
import type { AgentMode, PlanHooks } from '../harness/factory.js';
import { createAgentHarness } from '../harness/factory.js';
import { createPlanSession, writeFlow, writePrd } from '../plan/file-store.js';
import type { FooterContext as FooterContextValue, NoeticPlugin } from '../plugins/types.js';
import type { SkillDefinition } from '../skills/types.js';
import type { AgentRuntimeConfig } from '../types/config.js';
import { getModelContextLimit } from '../types/model-context.js';
import type { ChatStatus } from './components/index.js';
import { InkProvider, ResponsesChat } from './components/index.js';
import { PlanApprovalModal } from './components/plan-approval-modal.js';
import { FooterContextProvider } from './footer-context.js';
import type { ConversationEntry, ErrorEntry, SystemEntry, UserEntry } from './item-utils.js';
import {
  appendOrUpdateEntry,
  extractActivatedSkills,
  isErrorEntry,
  isSystemEntry,
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
    // Skip system UI entries that aren't part of the conversation
    if (isErrorEntry(entry) || isSystemEntry(entry)) {
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
  config: AgentRuntimeConfig;
  plugins: ReadonlyArray<NoeticPlugin>;
}

//#endregion

//#region App Component

interface ModalState {
  content: ReactNode;
  commandName: string;
  dismissMessage: string;
}

function App({ config, plugins }: AppProps): ReactNode {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [status, setStatus] = useState<ChatStatus>('ready');
  const [skills, setSkills] = useState<ReadonlyArray<SkillDefinition>>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [agentMode, setAgentModeState] = useState<AgentMode>('normal');

  const harnessRef = useRef<AgentHarness | null>(null);
  const harnessModeRef = useRef<AgentMode>('normal');
  const lastLayerUsageRef = useRef<LastLayerUsage | undefined>(undefined);
  const [lastLayerUsage, setLastLayerUsage] = useState<LastLayerUsage | undefined>(undefined);
  const memoryLayersRef = useRef<ReadonlyArray<MemoryLayer>>([]);
  const pendingApprovalRef = useRef<((approved: boolean) => void) | null>(null);
  // Stable per-session threadId so memory layers that persist by thread/resource
  // scope rehydrate across turns. Random UUID lives for the CLI process lifetime.
  const threadIdRef = useRef<string>(crypto.randomUUID());
  const sessionStartedAtRef = useRef<number>(Date.now());

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

  // Handle modal close (Escape pressed). If a plan-approval modal is open and
  // the user dismisses without explicitly accepting, we treat that as rejection
  // so the layer stays in plan mode rather than silently auto-approving.
  const handleModalClose = useCallback(() => {
    if (!modal) {
      return;
    }
    if (pendingApprovalRef.current) {
      pendingApprovalRef.current(false);
      pendingApprovalRef.current = null;
    }
    setEntries((prev) => [
      ...prev,
      {
        role: 'system',
        type: 'info',
        content: modal.dismissMessage,
      } satisfies SystemEntry,
    ]);
    setModal(null);
  }, [
    modal,
  ]);

  // Plan-mode hooks: own session creation and approval-modal lifecycle.
  // Memoised once — they read from refs so they don't need React re-renders.
  const planHooks = useMemo<PlanHooks>(
    () => ({
      onEnterSession: async () => createPlanSession(),
      onExit: async (state: PlanState) => {
        const slug = state.planSlug;
        return new Promise<{
          approved: boolean;
        }>((resolve) => {
          pendingApprovalRef.current = async (approved) => {
            if (approved && slug) {
              if (state.prd) {
                await writePrd(slug, state.prd);
              }
              if (state.planTree) {
                await writeFlow(slug, state.planTree).catch(() => {
                  // planTree may be a legacy PlanNode that doesn't match the flow schema; ignore.
                });
              }
            }
            resolve({
              approved,
            });
          };
          setModal({
            content: (
              <PlanApprovalModal
                prd={state.prd ?? '(no PRD)'}
                planTree={state.planTree}
                onAccept={() => {
                  const cb = pendingApprovalRef.current;
                  pendingApprovalRef.current = null;
                  setModal(null);
                  cb?.(true);
                }}
                onReject={() => {
                  const cb = pendingApprovalRef.current;
                  pendingApprovalRef.current = null;
                  setModal(null);
                  cb?.(false);
                }}
              />
            ),
            commandName: 'plan/exitPlanMode',
            dismissMessage: 'Plan approval dismissed (treated as rejection).',
          });
        });
      },
    }),
    [],
  );

  /**
   * Get or create the harness for the requested mode. If the requested mode
   * differs from the active harness's mode, the existing harness is discarded
   * and a fresh one is built so the model sees the correct toolset.
   */
  const getOrCreateHarness = useCallback(
    async (mode: AgentMode): Promise<AgentHarness> => {
      if (harnessRef.current !== null && harnessModeRef.current === mode) {
        return harnessRef.current;
      }
      const {
        harness,
        skills: resolvedSkills,
        memoryLayers,
      } = await createAgentHarness({
        config,
        plugins,
        fs: config.fs,
        mode,
        planHooks,
      });
      harnessRef.current = harness;
      harnessModeRef.current = mode;
      memoryLayersRef.current = memoryLayers;
      setSkills(resolvedSkills);
      return harness;
    },
    [
      config,
      plugins,
      planHooks,
    ],
  );

  // Switching mode invalidates the cached harness so the next turn rebuilds with
  // the correct tool set. We don't proactively rebuild here — `getOrCreateHarness`
  // does it lazily on the next message.
  const setAgentMode = useCallback(async (mode: AgentMode): Promise<void> => {
    if (harnessModeRef.current !== mode) {
      harnessRef.current = null;
    }
    setAgentModeState(mode);
  }, []);

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
              lastLayerUsage: lastLayerUsageRef.current,
              memoryLayers: memoryLayersRef.current,
              agentMode,
              setAgentMode,
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
              } else if (result.type === 'modal') {
                // Add command invocation to chat history
                setEntries((prev) => [
                  ...prev,
                  {
                    role: 'system',
                    type: 'info',
                    content: `/${result.commandName}`,
                  } satisfies SystemEntry,
                ]);
                // Open modal overlay
                setModal({
                  content: result.node,
                  commandName: result.commandName,
                  dismissMessage: result.dismissMessage,
                });
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
        const harness = await getOrCreateHarness(agentMode);
        // Build conversation history including the new user message
        const historyItems = entriesToItems([
          ...entriesRef.current,
          userEntry,
        ]);
        const result = harness.execute(historyItems, {
          threadId: threadIdRef.current,
        });
        setStatus('streaming');
        for await (const item of result.getItemStream()) {
          setEntries((prev) => appendOrUpdateEntry(prev, item));
        }
        const finalResponse = await result.getResponse();
        lastLayerUsageRef.current = finalResponse.lastLayerUsage;
        setLastLayerUsage(finalResponse.lastLayerUsage);
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
      agentMode,
      setAgentMode,
    ],
  );

  const footerValue = useMemo<FooterContextValue>(
    () => ({
      model: config.model,
      cwd: config.cwd,
      status,
      lastLayerUsage,
      contextLimit: getModelContextLimit(config.model),
      threadId: threadIdRef.current,
      sessionStartedAt: sessionStartedAtRef.current,
      entryCount: entries.length,
      agentMode,
    }),
    [
      config.model,
      config.cwd,
      status,
      lastLayerUsage,
      entries.length,
      agentMode,
    ],
  );

  return (
    <InkProvider>
      <FooterContextProvider value={footerValue}>
        <ResponsesChat
          entries={entries}
          status={status}
          onSubmit={handleSubmit}
          model={config.model}
          commands={commandSuggestions}
          modalContent={modal?.content}
          onModalClose={handleModalClose}
          plugins={plugins}
        />
      </FooterContextProvider>
    </InkProvider>
  );
}

//#endregion

//#region Entry Point

export async function runAgent(
  plugins: ReadonlyArray<NoeticPlugin>,
  config: AgentRuntimeConfig,
): Promise<void> {
  const { waitUntilExit } = render(<App config={config} plugins={plugins} />);
  await waitUntilExit();
}

//#endregion
