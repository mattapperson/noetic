/**
 * Root TUI application — Ink-rendered interactive agent loop.
 */

import type {
  AgentHarness,
  LastLayerUsage,
  MemoryLayer,
  PlanState,
  ShellAdapter,
  StreamEvent,
} from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/core';
import { render } from 'ink';
import type { MutableRefObject, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BUILTIN_COMMANDS,
  commandsToPromptSuggestions,
  executeCommand,
  findCommand,
  isSlashCommand,
  parseBashCommand,
  parseSlashCommand,
} from '../commands/index.js';
import type { Command, CommandContext } from '../commands/types.js';
import type { AgentMode, PlanHooks } from '../harness/factory.js';
import { createAgentHarness } from '../harness/factory.js';
import { createPlanSession, writeFlow, writePrd } from '../plan/file-store.js';
import { createPluginContextBuilder } from '../plugins/context.js';
import type { FooterContext as FooterContextValue, NoeticPlugin } from '../plugins/types.js';
import { buildSkillCatalog } from '../skills/catalog.js';
import type { SkillDefinition } from '../skills/types.js';
import type { AgentRuntimeConfig } from '../types/config.js';
import { getModelContextLimit } from '../types/model-context.js';
import type { LocalBashResult } from './bash-command.js';
import {
  buildBashCommandEntry,
  buildCdBashResult,
  buildCdEntry,
  buildCdErrorEntry,
  buildCdSplitNoticeEntry,
  firstToken,
  formatLocalStdoutBlock,
  handleCd,
  LOCAL_COMMAND_CAVEAT,
  parseCdArg,
  runUserShellCommand,
} from './bash-command.js';
import type { ChatStatus } from './components/index.js';
import { InkProvider, ResponsesChat } from './components/index.js';
import { PlanApprovalModal } from './components/plan-approval-modal.js';
import { FooterContextProvider } from './footer-context.js';
import type {
  AssistantEntry,
  ConversationEntry,
  ErrorEntry,
  SystemEntry,
  UserEntry,
} from './item-utils.js';
import {
  appendOrUpdateEntry,
  extractActivatedSkills,
  extractTextContent,
  getItemId,
  isUserEntry,
} from './item-utils.js';
import type { LiveTokens, StreamMetricsRefs } from './stream-metrics-context.js';
import { StreamMetricsProvider } from './stream-metrics-context.js';

//#region Helpers

function buildErrorEntry(error: unknown): ErrorEntry {
  return {
    role: 'system',
    type: 'error',
    content: `Error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function isFrameworkEvent(event: StreamEvent): event is Extract<
  StreamEvent,
  {
    source: 'framework';
  }
> {
  return event.source === 'framework';
}

function extractEventSuffix(type: string): string {
  const idx = type.indexOf(':');
  if (idx < 0) {
    return type;
  }
  return type.slice(idx + 1);
}

/** Flip matching queued UserEntry to 'sent' by id. Returns a new array if any
 *  entry was updated; otherwise returns the input reference. */
function markUserEntrySent(entries: ConversationEntry[], id: string): ConversationEntry[] {
  const idx = entries.findIndex((e) => isUserEntry(e) && e.id === id);
  if (idx < 0) {
    return entries;
  }
  const entry = entries[idx];
  if (!entry || !isUserEntry(entry)) {
    return entries;
  }
  const updated: UserEntry = {
    ...entry,
    deliveryStatus: 'sent',
  };
  const next = [
    ...entries,
  ];
  next[idx] = updated;
  return next;
}

/**
 * Prepend any pending local-bash outputs (from `!` / auto-detected commands)
 * as a `<local-command-caveat>` + `<local-command-stdout>` block in front of
 * the user's text, so the next model turn sees the shell output but treats
 * it as context rather than a user message.
 */
function augmentTextWithPendingBash(text: string, pending: ReadonlyArray<LocalBashResult>): string {
  if (pending.length === 0) {
    return text;
  }
  const blocks = pending.map(formatLocalStdoutBlock).join('\n');
  return `${LOCAL_COMMAND_CAVEAT}\n${blocks}\n\n${text}`;
}

//#endregion

//#region Types

interface AppProps {
  config: AgentRuntimeConfig;
  plugins: ReadonlyArray<NoeticPlugin>;
}

interface ModalState {
  content: ReactNode;
  commandName: string;
  dismissMessage: string;
}

//#endregion

//#region Stream consumers

interface ConsumeItemsOpts {
  harness: AgentHarness;
  threadId: string;
  setEntries: (updater: (prev: ConversationEntry[]) => ConversationEntry[]) => void;
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}

/**
 * For each streaming assistant message item, bump the live output-char counter
 * by whatever new text appeared since the last yield of that item. The
 * counter is reset per-turn by `consumeFullStream` on `turn_started`.
 */
function trackLiveOutput(opts: {
  item: AssistantEntry;
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}): void {
  if (opts.item.type !== 'message') {
    return;
  }
  const id = getItemId(opts.item);
  const currentLen = extractTextContent(opts.item).length;
  const previousLen = opts.perItemCharsRef.current.get(id) ?? 0;
  if (currentLen <= previousLen) {
    return;
  }
  const delta = currentLen - previousLen;
  opts.perItemCharsRef.current.set(id, currentLen);
  opts.streamMetrics.liveOutputChars.current += delta;
  if (opts.streamMetrics.firstTokenAt.current === null) {
    opts.streamMetrics.firstTokenAt.current = Date.now();
  }
}

async function consumeItemStream(opts: ConsumeItemsOpts): Promise<void> {
  try {
    for await (const item of opts.harness.getItemStream({
      threadId: opts.threadId,
    })) {
      trackLiveOutput({
        item,
        streamMetrics: opts.streamMetrics,
        perItemCharsRef: opts.perItemCharsRef,
      });
      opts.setEntries((prev) => appendOrUpdateEntry(prev, item));
    }
  } catch (err: unknown) {
    opts.setEntries((prev) => [
      ...prev,
      buildErrorEntry(err),
    ]);
  }
}

interface ConsumeEventsOpts {
  harness: AgentHarness;
  threadId: string;
  setEntries: (updater: (prev: ConversationEntry[]) => ConversationEntry[]) => void;
  setStatus: (s: ChatStatus) => void;
  setLastLayerUsage: (u: LastLayerUsage | undefined) => void;
  lastLayerUsageRef: {
    current: LastLayerUsage | undefined;
  };
  pendingMessageIdsRef: {
    current: Set<string>;
  };
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}

function resetTurnMetrics(opts: {
  streamMetrics: StreamMetricsRefs;
  perItemCharsRef: MutableRefObject<Map<string, number>>;
}): void {
  opts.streamMetrics.turnStartedAt.current = Date.now();
  opts.streamMetrics.firstTokenAt.current = null;
  opts.streamMetrics.liveOutputChars.current = 0;
  opts.streamMetrics.liveTokens.current = null;
  opts.perItemCharsRef.current.clear();
}

async function consumeFullStream(opts: ConsumeEventsOpts): Promise<void> {
  try {
    for await (const event of opts.harness.getFullStream({
      threadId: opts.threadId,
    })) {
      if (!isFrameworkEvent(event)) {
        continue;
      }
      const suffix = extractEventSuffix(event.type);
      if (suffix === 'turn_started') {
        const rawIds = event.data.messageIds;
        const ids = Array.isArray(rawIds)
          ? rawIds.filter((id): id is string => typeof id === 'string')
          : [];
        opts.setEntries((prev) => {
          let next = prev;
          for (const id of ids) {
            if (opts.pendingMessageIdsRef.current.has(id)) {
              opts.pendingMessageIdsRef.current.delete(id);
              next = markUserEntrySent(next, id);
            }
          }
          return next;
        });
        resetTurnMetrics({
          streamMetrics: opts.streamMetrics,
          perItemCharsRef: opts.perItemCharsRef,
        });
        opts.setStatus('streaming');
        continue;
      }
      if (suffix === 'turn_completed' || suffix === 'turn_aborted') {
        try {
          const resp = await opts.harness.getAgentResponse({
            threadId: opts.threadId,
          });
          opts.lastLayerUsageRef.current = resp.lastLayerUsage;
          opts.setLastLayerUsage(resp.lastLayerUsage);
          const exact: LiveTokens = {
            input: resp.usage.inputTokens,
            output: resp.usage.outputTokens,
            cached: resp.usage.cachedTokens,
          };
          opts.streamMetrics.liveTokens.current = exact;
        } catch {
          // getAgentResponse can only reject if no session exists; here it does.
        }
        if (
          opts.harness.getQueueSize({
            threadId: opts.threadId,
          }) === 0
        ) {
          opts.streamMetrics.turnStartedAt.current = null;
          opts.setStatus('ready');
        }
      }
    }
  } catch {
    // Stream ended — normal on harness swap.
  }
}

//#endregion

//#region App Component

function App({ config, plugins }: AppProps): ReactNode {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [status, setStatus] = useState<ChatStatus>('ready');
  const [skills, setSkills] = useState<ReadonlyArray<SkillDefinition>>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [pluginCommands, setPluginCommands] = useState<ReadonlyArray<Command>>([]);
  const [agentMode, setAgentModeState] = useState<AgentMode>('normal');
  const [model, setModelState] = useState<string>(config.model);
  const harnessModelRef = useRef<string>(config.model);
  const [effectiveCwd, setEffectiveCwd] = useState<string>(config.cwd);

  const buildCtx = useMemo(
    () => createPluginContextBuilder(config),
    [
      config,
    ],
  );

  const harnessRef = useRef<AgentHarness | null>(null);
  const harnessModeRef = useRef<AgentMode>('normal');
  const lastLayerUsageRef = useRef<LastLayerUsage | undefined>(undefined);
  const [lastLayerUsage, setLastLayerUsage] = useState<LastLayerUsage | undefined>(undefined);
  const memoryLayersRef = useRef<ReadonlyArray<MemoryLayer>>([]);
  const pendingApprovalRef = useRef<((approved: boolean) => void) | null>(null);
  const threadIdRef = useRef<string>(crypto.randomUUID());
  const sessionStartedAtRef = useRef<number>(Date.now());
  const pendingMessageIdsRef = useRef<Set<string>>(new Set());
  const streamWiredHarnessRef = useRef<AgentHarness | null>(null);

  const turnStartedAtRef = useRef<number | null>(null);
  const firstTokenAtRef = useRef<number | null>(null);
  const liveOutputCharsRef = useRef<number>(0);
  const liveTokensRef = useRef<LiveTokens | null>(null);
  const perItemCharsRef = useRef<Map<string, number>>(new Map());

  const streamMetrics = useMemo<StreamMetricsRefs>(
    () => ({
      turnStartedAt: turnStartedAtRef,
      firstTokenAt: firstTokenAtRef,
      liveOutputChars: liveOutputCharsRef,
      liveTokens: liveTokensRef,
    }),
    [],
  );

  const shellRef = useRef<ShellAdapter | null>(null);
  if (shellRef.current === null) {
    shellRef.current = createLocalShellAdapter();
  }
  const effectiveCwdRef = useRef<string>(config.cwd);
  const prevCwdRef = useRef<string | null>(null);
  const pendingBashOutputsRef = useRef<LocalBashResult[]>([]);
  const cdNoticeShownRef = useRef<boolean>(false);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    let cancelled = false;
    async function collect(): Promise<void> {
      const lists = await Promise.all(
        plugins.map(async (p): Promise<ReadonlyArray<Command>> => {
          if (!p.commands) {
            return [];
          }
          try {
            return await p.commands(buildCtx(p.name));
          } catch {
            return [];
          }
        }),
      );
      if (cancelled) {
        return;
      }
      setPluginCommands(lists.flat());
    }
    void collect();
    return () => {
      cancelled = true;
    };
  }, [
    plugins,
    buildCtx,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function prime(): Promise<void> {
      try {
        const catalog = await buildSkillCatalog({
          cwd: config.cwd,
          plugins,
          fs: config.fs,
          buildCtx,
        });
        if (cancelled) {
          return;
        }
        setSkills(catalog);
      } catch {
        // Swallow — skill discovery failures shouldn't prevent the TUI booting.
      }
    }
    void prime();
    return () => {
      cancelled = true;
    };
  }, [
    config,
    plugins,
    buildCtx,
  ]);

  const commands = useMemo<Command[]>(
    () => [
      ...BUILTIN_COMMANDS,
      ...pluginCommands,
    ],
    [
      pluginCommands,
    ],
  );

  const commandSuggestions = useMemo(
    () => commandsToPromptSuggestions(commands),
    [
      commands,
    ],
  );

  const clearEntries = useCallback(() => {
    setEntries([]);
  }, []);

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

  /** Wire long-lived consumers to the harness's session streams. Called once
   *  per harness instance via `getOrCreateHarness`. */
  const wireStreams = useCallback(
    (harness: AgentHarness) => {
      if (streamWiredHarnessRef.current === harness) {
        return;
      }
      streamWiredHarnessRef.current = harness;
      const threadId = threadIdRef.current;

      void consumeItemStream({
        harness,
        threadId,
        setEntries,
        streamMetrics,
        perItemCharsRef,
      });
      void consumeFullStream({
        harness,
        threadId,
        setEntries,
        setStatus,
        setLastLayerUsage,
        lastLayerUsageRef,
        pendingMessageIdsRef,
        streamMetrics,
        perItemCharsRef,
      });
    },
    [
      streamMetrics,
    ],
  );

  const getOrCreateHarness = useCallback(
    async (mode: AgentMode, activeModel: string): Promise<AgentHarness> => {
      if (
        harnessRef.current !== null &&
        harnessModeRef.current === mode &&
        harnessModelRef.current === activeModel
      ) {
        return harnessRef.current;
      }
      const {
        harness,
        skills: resolvedSkills,
        memoryLayers,
      } = await createAgentHarness({
        config: {
          ...config,
          model: activeModel,
        },
        plugins,
        fs: config.fs,
        mode,
        planHooks,
        buildContext: buildCtx,
      });
      harnessRef.current = harness;
      harnessModeRef.current = mode;
      harnessModelRef.current = activeModel;
      memoryLayersRef.current = memoryLayers;
      setSkills(resolvedSkills);
      wireStreams(harness);
      return harness;
    },
    [
      config,
      plugins,
      planHooks,
      buildCtx,
      wireStreams,
    ],
  );

  /** Discard the current harness so the next submit recreates it with fresh config. */
  const invalidateHarness = useCallback((): void => {
    harnessRef.current = null;
    streamWiredHarnessRef.current = null;
  }, []);

  const setAgentMode = useCallback(
    async (mode: AgentMode): Promise<void> => {
      if (harnessModeRef.current !== mode) {
        invalidateHarness();
      }
      setAgentModeState(mode);
    },
    [
      invalidateHarness,
    ],
  );

  const setModel = useCallback(
    async (nextModel: string): Promise<void> => {
      if (harnessModelRef.current !== nextModel) {
        invalidateHarness();
      }
      setModelState(nextModel);
    },
    [
      invalidateHarness,
    ],
  );

  const handleStop = useCallback(async () => {
    const harness = harnessRef.current;
    if (!harness) {
      return;
    }
    await harness.abort({
      threadId: threadIdRef.current,
      reason: 'user-requested',
    });
  }, []);

  /** Run a `cd` in-process and update the session-scoped `effectiveCwd`. */
  const runCd = useCallback(
    (command: string): void => {
      const result = handleCd({
        arg: parseCdArg(command),
        effectiveCwd: effectiveCwdRef.current,
        prevCwd: prevCwdRef.current,
      });
      if (result.kind === 'error') {
        setEntries((prev) => [
          ...prev,
          buildCdErrorEntry(result.message),
        ]);
        return;
      }
      prevCwdRef.current = result.previousCwd;
      effectiveCwdRef.current = result.newCwd;
      setEffectiveCwd(result.newCwd);
      pendingBashOutputsRef.current.push(buildCdBashResult(command, result.newCwd));

      const extras: SystemEntry[] = [];
      extras.push(buildCdEntry(result.newCwd));
      if (!cdNoticeShownRef.current) {
        cdNoticeShownRef.current = true;
        extras.push(buildCdSplitNoticeEntry(config.cwd));
      }
      setEntries((prev) => [
        ...prev,
        ...extras,
      ]);
    },
    [
      config.cwd,
    ],
  );

  /** Execute a `!` or auto-detected command locally, append transcript
   *  entry, and stash the result for the next agent turn. */
  const runLocalBash = useCallback(
    async (command: string): Promise<void> => {
      if (firstToken(command) === 'cd') {
        runCd(command);
        return;
      }
      const shell = shellRef.current;
      if (shell === null) {
        return;
      }
      try {
        const result = await runUserShellCommand({
          shell,
          cwd: effectiveCwdRef.current,
          command,
        });
        pendingBashOutputsRef.current.push(result);
        setEntries((prev) => [
          ...prev,
          buildBashCommandEntry(result),
        ]);
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          buildErrorEntry(error),
        ]);
      }
    },
    [
      runCd,
    ],
  );

  const handleSubmit = useCallback(
    async (text: string): Promise<void> => {
      const bashCommand = parseBashCommand(text);
      if (bashCommand !== null) {
        await runLocalBash(bashCommand);
        return;
      }

      if (isSlashCommand(text)) {
        const parsed = parseSlashCommand(text);
        if (parsed) {
          const cmd = findCommand(parsed.commandName, commands);
          if (cmd) {
            const activatedSkills = extractActivatedSkills(entriesRef.current);
            const ctx: CommandContext = {
              config: {
                ...config,
                model,
              },
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
              setModel,
            };

            try {
              const result = await executeCommand({
                command: cmd,
                args: parsed.args,
                ctx,
                options: {
                  onJsxComplete: (summary) => {
                    if (summary) {
                      setEntries((prev) => [
                        ...prev,
                        {
                          role: 'system',
                          type: 'info',
                          content: summary,
                        } satisfies SystemEntry,
                      ]);
                    }
                    setModal(null);
                  },
                },
              });
              if (result.type === 'text') {
                setEntries((prev) => [
                  ...prev,
                  {
                    role: 'system',
                    type: 'info',
                    content: result.value,
                  } satisfies SystemEntry,
                ]);
              } else if (result.type === 'modal') {
                setEntries((prev) => [
                  ...prev,
                  {
                    role: 'system',
                    type: 'info',
                    content: `/${result.commandName}`,
                  } satisfies SystemEntry,
                ]);
                setModal({
                  content: result.node,
                  commandName: result.commandName,
                  dismissMessage: result.dismissMessage,
                });
              }
            } catch (error) {
              setEntries((prev) => [
                ...prev,
                buildErrorEntry(error),
              ]);
            }
            return;
          }
        }
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

      // Snapshot pending bash outputs now so any `!cmd` the user runs during
      // the agent turn falls through to the NEXT flush instead of being
      // dropped here.
      const pendingSnapshot: ReadonlyArray<LocalBashResult> = [
        ...pendingBashOutputsRef.current,
      ];
      const augmented = augmentTextWithPendingBash(text, pendingSnapshot);
      try {
        const harness = await getOrCreateHarness(agentMode, model);
        const isBusy =
          harness.getStatus({
            threadId: threadIdRef.current,
          }).kind !== 'idle';
        const messageId = `msg-${crypto.randomUUID()}`;
        const userEntry: UserEntry = {
          role: 'user',
          content: text,
          id: messageId,
          deliveryStatus: isBusy ? 'queued' : 'sent',
        };
        setEntries((prev) => [
          ...prev,
          userEntry,
        ]);

        if (isBusy) {
          pendingMessageIdsRef.current.add(messageId);
        }
        setStatus('submitted');

        await harness.execute(augmented, {
          threadId: threadIdRef.current,
          messageId,
        });
        // Drop only what we sent — any output appended during the await from
        // a concurrent `!cmd` must survive to ride the next turn.
        if (pendingSnapshot.length > 0) {
          pendingBashOutputsRef.current.splice(0, pendingSnapshot.length);
        }
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          buildErrorEntry(error),
        ]);
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
      model,
      setModel,
      runLocalBash,
    ],
  );

  const footerValue = useMemo<FooterContextValue>(
    () => ({
      model,
      cwd: effectiveCwd,
      status,
      lastLayerUsage,
      contextLimit: getModelContextLimit(model),
      threadId: threadIdRef.current,
      sessionStartedAt: sessionStartedAtRef.current,
      entryCount: entries.length,
      agentMode,
    }),
    [
      effectiveCwd,
      status,
      lastLayerUsage,
      entries.length,
      agentMode,
      model,
    ],
  );

  return (
    <InkProvider>
      <FooterContextProvider value={footerValue}>
        <StreamMetricsProvider value={streamMetrics}>
          <ResponsesChat
            entries={entries}
            status={status}
            onSubmit={handleSubmit}
            onStop={handleStop}
            model={model}
            commands={commandSuggestions}
            modalContent={modal?.content}
            onModalClose={handleModalClose}
            plugins={plugins}
          />
        </StreamMetricsProvider>
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
