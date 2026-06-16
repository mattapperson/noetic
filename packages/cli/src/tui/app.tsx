/**
 * Root TUI application — Ink-rendered interactive agent loop.
 */

import { render } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSingleFlight } from '../util/single-flight.js';
import type {
  Command,
  CommandContext,
  SessionRestartTarget,
  SessionSnapshot,
  ViewMode,
} from './app-parts/commands.js';
import {
  BUILTIN_COMMANDS,
  commandsToPromptSuggestions,
  ensureChatTarget,
  ensureDaemon,
  executeCommand,
  findCommand,
  isSlashCommand,
  parseBashCommand,
  parseSlashCommand,
} from './app-parts/commands.js';
import type {
  AgentHarness,
  AskUserOutput,
  InputContentPart,
  InputMessageItem,
  Item,
  LastLayerUsage,
  LspService,
  MemoryLayer,
  PendingAskUserRequest,
  PlanState,
  ShellAdapter,
  SkillDefinition,
  TeammateRegistry,
} from './app-parts/deps.js';
import {
  buildSkillCatalog,
  createAskUserService,
  createLocalShellAdapter,
} from './app-parts/deps.js';
import {
  augmentTextWithPendingBash,
  buildErrorEntry,
  countUserMessages,
  deriveFirstPrompt,
  normalizeEntriesForResume,
  resolveOpenChatTransition,
} from './app-parts/helpers.js';
import type {
  AgentMode,
  AgentRuntimeConfig,
  FooterContext,
  NoeticPlugin,
  PlanHooks,
  SaveResult,
  SessionFile,
} from './app-parts/services.js';
import {
  createAgentHarness,
  createLspService,
  createPlanSession,
  createPluginContextBuilder,
  getModelContextLimit,
  loadSession,
  loadSessionByIdAnywhere,
  saveSession,
  stripUnresolvedToolCalls,
  writeFlow,
  writePrd,
} from './app-parts/services.js';
import { consumeFullStream, consumeItemStream } from './app-parts/stream-consumers.js';
import type {
  ChatStatus,
  ConversationEntry,
  ErrorEntry,
  ExitActionStatus,
  LiveTokens,
  LocalBashResult,
  PromptInputMessage,
  StreamMetricsRefs,
  SystemEntry,
  UserEntry,
} from './app-parts/ui.js';
import {
  AskUserModal,
  buildBashCommandEntry,
  buildCdBashResult,
  buildCdEntry,
  buildCdErrorEntry,
  buildCdSplitNoticeEntry,
  extractActivatedSkills,
  FooterContextProvider,
  getDefaultImageStore,
  getFirstCommand,
  handleCd,
  InkProvider,
  installSuspendResumeHandlers,
  PlanApprovalModal,
  parseCdArg,
  ResponsesChat,
  reattachLiveChildren,
  resolvePromptAttachments,
  runUserShellCommand,
  StreamMetricsProvider,
  useExitOnInterrupt,
} from './app-parts/ui.js';
import { ChatLayout } from './components/chat-layout.js';
import { RootCanvas } from './components/root-canvas.js';
import { nextFocus } from './layout/next-focus.js';
import type { ContextPanelWidthConfig, Pane } from './layout/types.js';
import { TaskChatSpawningView, TaskChatView } from './task-chat/task-chat-view.js';
import { TaskBoard } from './tasks/runtime-ui/task-board.js';

//#region Types

interface AppProps {
  config: AgentRuntimeConfig;
  plugins: ReadonlyArray<NoeticPlugin>;
  /** A persisted session to resume. `null` starts fresh. */
  initialSession: SessionFile | null;
  /** When true, session saves are skipped. Resume still works from existing files. */
  disablePersistence: boolean;
  /** From `-n/--name`. Applied as `customTitle` on the next save. */
  name?: string;
  /**
   * From `--session-id <uuid>`. When set and no session is being resumed,
   * this UUID is used as the thread id / session id so the first save lands
   * at that path. Ignored on resume (the saved session's id wins).
   */
  forcedSessionId?: string;
  /** Called by `/resume` when the user wants to restart against a different session. */
  onRestart: (target: SessionRestartTarget) => void;
  /**
   * Called when the user explicitly asks to exit the TUI (e.g. via the
   * Ctrl+C double-press). The runner is responsible for unmounting Ink and
   * resolving the session promise; the App just signals intent.
   */
  onRequestExit: () => void;
}

interface ModalState {
  content: ReactNode;
  commandName: string;
  dismissMessage: string;
}

//#endregion

//#region App Component

function App({
  config,
  plugins,
  initialSession,
  disablePersistence,
  name,
  forcedSessionId,
  onRestart,
  onRequestExit,
}: AppProps): ReactNode {
  useEffect(() => {
    try {
      ensureDaemon(config.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[warn] [tasks daemon] startup failed: ${message}\n`);
    }
  }, [
    config.cwd,
  ]);

  const initialEntries = useMemo(
    () => (initialSession ? normalizeEntriesForResume(initialSession.entries) : []),
    [
      initialSession,
    ],
  );
  const [entries, setEntries] = useState<ConversationEntry[]>(initialEntries);
  const [status, setStatus] = useState<ChatStatus>('ready');
  const [skills, setSkills] = useState<ReadonlyArray<SkillDefinition>>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [pluginCommands, setPluginCommands] = useState<ReadonlyArray<Command>>([]);
  const [agentMode, setAgentModeState] = useState<AgentMode>(initialSession?.agentMode ?? 'act');
  const [viewMode, setViewMode] = useState<ViewMode>({
    kind: 'chat',
  });
  // Context Split View dock state — session-local. See specs/28-context-split-view.md.
  const [contextPanelOpen, setContextPanelOpen] = useState<boolean>(false);
  const [focusedPane, setFocusedPane] = useState<Pane>('chat');
  // One-shot flag: open the dock automatically the FIRST time the user
  // submits a real prompt (anything that isn't a slash command). Stored as
  // a ref so a user who closes the dock later doesn't get it re-opened on
  // their next submission. Persists for the lifetime of this React tree;
  // a fresh session/clear resets it via the component remount.
  const hasAutoOpenedContextPanelRef = useRef(false);
  // Transient one-line notice rendered below the prompt. Cleared by a
  // timeout (~4s) or by the next user submission. Notices are ephemeral UI
  // confirmations ("dock opened", "mode switched") that don't belong in
  // the chat scroll.
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  useEffect(() => {
    if (statusNotice === null) {
      return;
    }
    const id = setTimeout(() => setStatusNotice(null), 4000);
    return (): void => {
      clearTimeout(id);
    };
  }, [
    statusNotice,
  ]);
  const [model, setModelState] = useState<string>(config.model);
  const harnessModelRef = useRef<string>(config.model);
  const [effectiveCwd, setEffectiveCwd] = useState<string>(
    initialSession?.effectiveCwd ?? config.cwd,
  );

  const buildCtx = useMemo(
    () => createPluginContextBuilder(config),
    [
      config,
    ],
  );

  const harnessRef = useRef<AgentHarness | null>(null);
  const harnessDisposeRef = useRef<(() => Promise<void>) | null>(null);
  /** Serializes harness creation — see the single-flight wrap in
   *  `getOrCreateHarness`. */
  const harnessFlightRef = useRef(createSingleFlight());
  /**
   * Set to true after the first harness creation performs its one-shot
   * `reattachLiveChildren` pass. Re-harnessing on /model or /plan must
   * not re-run reattach — the adapter is shared across swaps and has
   * already rebound any durable children.
   */
  const reattachDoneRef = useRef<boolean>(false);
  // Owned by the TUI (not the harness) so language-server subprocesses survive
  // /model and /plan swaps, which recreate the harness.
  const lspServiceRef = useRef<LspService | null>(null);
  const harnessModeRef = useRef<AgentMode>(initialSession?.agentMode ?? 'act');
  const lastLayerUsageRef = useRef<LastLayerUsage | undefined>(initialSession?.lastLayerUsage);
  const [lastLayerUsage, setLastLayerUsage] = useState<LastLayerUsage | undefined>(
    initialSession?.lastLayerUsage,
  );
  const memoryLayersRef = useRef<ReadonlyArray<MemoryLayer>>([]);
  const teammatesRef = useRef<TeammateRegistry | null>(null);
  const pendingApprovalRef = useRef<((approved: boolean) => void) | null>(null);
  // Created once per TUI session; survives harness swaps on /model or /plan.
  const askUserService = useMemo(() => createAskUserService(), []);
  const [askUserRequest, setAskUserRequest] = useState<PendingAskUserRequest | null>(null);
  const threadIdRef = useRef<string>(
    initialSession?.sessionId ?? forcedSessionId ?? crypto.randomUUID(),
  );
  const sessionStartedAtRef = useRef<number>(
    initialSession ? Date.parse(initialSession.createdAt) : Date.now(),
  );
  const pendingMessageIdsRef = useRef<Set<string>>(new Set());
  const streamWiredHarnessRef = useRef<AgentHarness | null>(null);
  /** Session epoch — bumped by `/clear` and by harness invalidation. Stream
   *  consumers wired under an older epoch treat themselves as stale and stop
   *  producing ANY side effects (entries, usage, persistence, status). */
  const sessionEpochRef = useRef<number>(0);
  /** Aborts the previous wiring's stream-consumer loops when a new harness
   *  is wired or the session is cleared. */
  const streamAbortRef = useRef<AbortController | null>(null);

  /** Holds the canonical item list used to seed every harness recreation —
   *  seeded from the resumed session's items on mount and refreshed after
   *  every settled turn. A stale copy would mean a subsequent `/model` or
   *  `/plan` swap reseeds with pre-swap history only, dropping any turns
   *  that landed in between. */
  const resumedItemsRef = useRef<ReadonlyArray<Item> | null>(
    initialSession ? stripUnresolvedToolCalls(initialSession.items) : null,
  );
  const createdAtRef = useRef<string>(initialSession?.createdAt ?? new Date().toISOString());
  const customTitleRef = useRef<string | undefined>(name ?? initialSession?.customTitle);
  const tagRef = useRef<string | undefined>(initialSession?.tag);
  const cumulativeUsageRef = useRef<{
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  }>(
    initialSession?.cumulativeUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
  );
  const cumulativeCostRef = useRef<number>(initialSession?.cumulativeCost ?? 0);
  const lastSaveMtimeRef = useRef<number | undefined>(undefined);

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
  const effectiveCwdRef = useRef<string>(initialSession?.effectiveCwd ?? config.cwd);
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

  const setCustomTitle = useCallback((name: string | undefined) => {
    customTitleRef.current = name;
  }, []);

  const setTag = useCallback((next: string | undefined) => {
    tagRef.current = next;
  }, []);

  const buildSessionSnapshot = useCallback(
    (currentEntries: ReadonlyArray<ConversationEntry>): SessionSnapshot => ({
      sessionId: threadIdRef.current,
      cwd: config.cwd,
      effectiveCwd: effectiveCwdRef.current,
      model: harnessModelRef.current,
      createdAt: createdAtRef.current,
      customTitle: customTitleRef.current,
      tag: tagRef.current,
      firstPrompt: deriveFirstPrompt(currentEntries),
      messageCount: countUserMessages(currentEntries),
      cumulativeUsage: {
        ...cumulativeUsageRef.current,
      },
      cumulativeCost: cumulativeCostRef.current,
      persistenceEnabled: !disablePersistence,
    }),
    [
      config.cwd,
      disablePersistence,
    ],
  );

  const restartWithSession = useCallback(
    async (target: SessionRestartTarget): Promise<string | undefined> => {
      if (target.kind !== 'id') {
        onRestart(target);
        return undefined;
      }
      const file =
        (await loadSession(config.cwd, target.sessionId)) ??
        (await loadSessionByIdAnywhere(target.sessionId));
      if (file === null) {
        return `Session ${target.sessionId} not found.`;
      }
      onRestart({
        kind: 'file',
        file,
      });
      return undefined;
    },
    [
      config.cwd,
      onRestart,
    ],
  );

  const handleModalClose = useCallback(() => {
    if (!modal) {
      return;
    }
    // Dispatch by command name so the right owner is notified — never fire
    // both the plan-approval reject and the ask-user cancel for one dismiss.
    if (modal.commandName === 'ask-user') {
      askUserService.cancelAll('modal dismissed');
      installedAskUserIdRef.current = null;
    } else if (pendingApprovalRef.current) {
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
    askUserService,
  ]);

  // Subscribe to ask-user requests from the running tool and drive modal state.
  useEffect(() => {
    return askUserService.subscribe((pending) => {
      setAskUserRequest(pending);
    });
  }, [
    askUserService,
  ]);

  const handleAskUserSubmit = useCallback(
    (id: string, output: AskUserOutput): void => {
      askUserService.resolve(id, output);
      setModal(null);
    },
    [
      askUserService,
    ],
  );

  const handleAskUserCancel = useCallback(
    (id: string, reason: string): void => {
      askUserService.cancel(id, reason);
      setModal(null);
    },
    [
      askUserService,
    ],
  );

  // Tracks the pending ask-user id currently installed as a modal, so the
  // effect below is idempotent: if the modal is already ours for the current
  // request, we don't re-run setModal (which would create a new object each
  // render and loop).
  const installedAskUserIdRef = useRef<string | null>(null);

  // Render the ask-user modal whenever a request is pending and no other modal is active.
  // Also tear down any orphan ask-user modal when the underlying request goes away
  // (harness swap, programmatic cancelAll, etc.), so the dialog can't outlive
  // its owner.
  useEffect(() => {
    if (askUserRequest === null) {
      installedAskUserIdRef.current = null;
      // If our modal is still on screen but the request behind it is gone,
      // clear it so the user isn't left interacting with a dead dialog.
      if (modal?.commandName === 'ask-user') {
        setModal(null);
      }
      return;
    }
    if (installedAskUserIdRef.current === askUserRequest.id) {
      return;
    }
    if (modal !== null && modal.commandName !== 'ask-user') {
      // Another modal (e.g. plan approval) already holds the screen; defer.
      return;
    }
    installedAskUserIdRef.current = askUserRequest.id;
    setModal({
      commandName: 'ask-user',
      dismissMessage: 'Ask-user dialog dismissed (treated as cancellation).',
      content: (
        <AskUserModal
          input={askUserRequest.input}
          isPlanMode={agentMode === 'planning'}
          onSubmit={(output) => handleAskUserSubmit(askUserRequest.id, output)}
          onCancel={(reason) => handleAskUserCancel(askUserRequest.id, reason)}
          onFinishPlanInterview={() => {
            // In plan mode, short-circuit to ExitPlanMode semantics: cancel the
            // ask-user request, then let the agent proceed to exitPlanMode on
            // its next turn.
            handleAskUserCancel(askUserRequest.id, 'user pressed Finish Interview');
          }}
        />
      ),
    });
  }, [
    askUserRequest,
    modal,
    agentMode,
    handleAskUserSubmit,
    handleAskUserCancel,
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

  /**
   * Build the session save payload from current state and persist atomically.
   * Fire-and-forget; errors land on stderr. No-op when `--no-session-persistence`
   * is set.
   */
  const persistSession = useCallback(
    async (cleanedItems: ReadonlyArray<Item>): Promise<void> => {
      if (disablePersistence) {
        return;
      }
      const nowIso = new Date().toISOString();
      const currentEntries = entriesRef.current;
      const file: SessionFile = {
        version: 1,
        sessionId: threadIdRef.current,
        cwd: config.cwd,
        effectiveCwd: effectiveCwdRef.current,
        model: harnessModelRef.current,
        agentMode: harnessModeRef.current,
        createdAt: createdAtRef.current,
        modifiedAt: nowIso,
        customTitle: customTitleRef.current,
        tag: tagRef.current,
        firstPrompt: deriveFirstPrompt(currentEntries),
        messageCount: countUserMessages(currentEntries),
        cumulativeUsage: {
          ...cumulativeUsageRef.current,
        },
        cumulativeCost: cumulativeCostRef.current,
        lastLayerUsage: lastLayerUsageRef.current,
        items: [
          ...cleanedItems,
        ],
        entries: [
          ...currentEntries,
        ],
      };
      try {
        const result: SaveResult = await saveSession(file, {
          lastKnownMtimeMs: lastSaveMtimeRef.current,
        });
        lastSaveMtimeRef.current = result.mtimeMs;
        if (result.conflict) {
          process.stderr.write(
            `Warning: concurrent write detected for session ${file.sessionId}; overwrote anyway.\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(
          `Session save failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
    [
      config.cwd,
      disablePersistence,
    ],
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
      // Sever the previous wiring's loops, then bind this wiring to the
      // current epoch: if /clear or a harness swap bumps the epoch, these
      // consumers go inert even before the abort lands.
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      const epoch = sessionEpochRef.current;
      const isStale = (): boolean => sessionEpochRef.current !== epoch;

      void consumeItemStream({
        harness,
        threadId,
        isStale,
        signal: controller.signal,
        setEntries,
        streamMetrics,
        perItemCharsRef,
      });
      void consumeFullStream({
        harness,
        threadId,
        isStale,
        signal: controller.signal,
        setEntries,
        setStatus,
        setLastLayerUsage,
        lastLayerUsageRef,
        pendingMessageIdsRef,
        streamMetrics,
        perItemCharsRef,
        onTurnSettled: (resp) => {
          cumulativeUsageRef.current = {
            inputTokens: cumulativeUsageRef.current.inputTokens + resp.usage.inputTokens,
            outputTokens: cumulativeUsageRef.current.outputTokens + resp.usage.outputTokens,
            cachedTokens: cumulativeUsageRef.current.cachedTokens + (resp.usage.cachedTokens ?? 0),
          };
          if (resp.cost !== undefined) {
            cumulativeCostRef.current += resp.cost;
          }
          // Keep the ref in sync so a later `/model` or `/plan` swap reseeds
          // from the latest items rather than the original resume snapshot.
          const cleaned = stripUnresolvedToolCalls(resp.items);
          resumedItemsRef.current = cleaned;
          void persistSession(cleaned);
          // The agent's Bash `cd` mutates `harness.rootCwdState.cwd`. Mirror
          // that into the TUI's render state so the prompt path follows.
          const liveCwd = harnessRef.current?.rootCwdState.cwd;
          if (liveCwd !== undefined && liveCwd !== effectiveCwdRef.current) {
            effectiveCwdRef.current = liveCwd;
            setEffectiveCwd(liveCwd);
          }
        },
      });
    },
    [
      streamMetrics,
      persistSession,
    ],
  );

  const getOrCreateHarness = useCallback(
    async (mode: AgentMode, activeModel: string): Promise<AgentHarness> =>
      // Single-flight: two submits in the cold-start window must not build
      // two harnesses (split conversation, racing persist writers). The
      // cached-hit check lives INSIDE the flight so a caller that waited out
      // someone else's creation re-checks and reuses the winner's harness.
      harnessFlightRef.current(async (): Promise<AgentHarness> => {
        if (
          harnessRef.current !== null &&
          harnessModeRef.current === mode &&
          harnessModelRef.current === activeModel
        ) {
          return harnessRef.current;
        }
        if (lspServiceRef.current === null) {
          lspServiceRef.current = await createLspService({
            plugins,
            buildCtx,
            cwd: config.cwd,
            fs: config.fs,
          });
        }
        const {
          harness,
          skills: resolvedSkills,
          memoryLayers,
          dispose,
          teammates,
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
          lspService: lspServiceRef.current,
          askUserService,
          binaryAvailability: config.binaryAvailability,
        });
        // Dispose any previously-held harness resources before swapping.
        const previousDispose = harnessDisposeRef.current;
        if (previousDispose) {
          previousDispose().catch(() => {});
        }
        harnessDisposeRef.current = dispose;
        harnessRef.current = harness;
        harnessModeRef.current = mode;
        harnessModelRef.current = activeModel;
        memoryLayersRef.current = memoryLayers;
        teammatesRef.current = teammates;
        // Seed the new harness with any cwd accumulated from `!cd`s issued
        // before the first turn or during a /model or /plan harness swap.
        // Without this, the next turn's tools reset to launch-time cwd.
        harness.setRootCwd(effectiveCwdRef.current);
        // One-shot rediscovery of live subprocess children across a
        // parent-process restart. Cheap no-op when no durable storage is
        // configured on the adapter — see reattach-live-children.ts.
        if (!reattachDoneRef.current) {
          reattachDoneRef.current = true;
          await reattachLiveChildren(harness).catch((err: unknown) => {
            console.warn('reattachLiveChildren failed:', err);
          });
        }
        setSkills(resolvedSkills);
        if (resumedItemsRef.current !== null) {
          // Seed BEFORE wiring streams — wireStreams triggers lazy session
          // creation inside the harness via requireSession, and the session
          // runner reads session.accumulatedItems on each turn. Seeding first
          // ensures the first turn after resume has the full prior history.
          harness.seedSessionHistory(threadIdRef.current, resumedItemsRef.current);
        }
        wireStreams(harness);
        return harness;
      }),
    [
      config,
      plugins,
      planHooks,
      buildCtx,
      wireStreams,
      askUserService,
    ],
  );

  /** Discard the current harness so the next submit recreates it with fresh config. */
  const invalidateHarness = useCallback((): void => {
    // Stale-out the old wiring's stream consumers: anything they'd do after
    // this point (entries, usage, persistence) belongs to the dropped
    // harness, not to whatever gets wired next (/model and /plan swaps).
    sessionEpochRef.current += 1;
    // Drops the registry's references to running teammates. Does NOT abort
    // in-flight executions — DetachedHandle has no cancel API. Settle notices
    // posted by the dropped child go via WeakRef and are silently discarded.
    teammatesRef.current?.dropAll();
    teammatesRef.current = null;
    const dispose = harnessDisposeRef.current;
    harnessDisposeRef.current = null;
    if (dispose) {
      dispose().catch(() => {});
    }
    harnessRef.current = null;
    streamWiredHarnessRef.current = null;
    // Reject any in-flight ask-user request — its owning harness is gone, so
    // the dialog must close and the model's tool call gets a cancelled error.
    askUserService.cancelAll('harness invalidated');
  }, [
    askUserService,
  ]);

  const clearSession = useCallback(() => {
    // Full session reset: everything a `noetic --resume` would rebuild, plus
    // UI. Order is load-bearing:
    //   1. epoch++ makes the old stream consumers stale — even effects already
    //      past an await can no longer leak into the new session;
    //   2. aborting the stream controller unparks their `for await` loops;
    //   3. aborting the in-flight turn stops the old harness from generating
    //      (its partial items are intentionally discarded — /clear's contract
    //      is to forget the resumed history);
    //   4. invalidateHarness() drops + disposes the harness so the next
    //      submit recreates it fresh.
    sessionEpochRef.current += 1;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    const oldHarness = harnessRef.current;
    const oldThreadId = threadIdRef.current;
    if (oldHarness !== null) {
      void oldHarness
        .abort({
          threadId: oldThreadId,
          reason: 'session-cleared',
        })
        .catch(() => {});
    }
    invalidateHarness();
    threadIdRef.current = crypto.randomUUID();
    createdAtRef.current = new Date().toISOString();
    sessionStartedAtRef.current = Date.now();
    resumedItemsRef.current = null;
    customTitleRef.current = undefined;
    tagRef.current = undefined;
    cumulativeUsageRef.current = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    };
    cumulativeCostRef.current = 0;
    lastSaveMtimeRef.current = undefined;
    lastLayerUsageRef.current = undefined;
    setLastLayerUsage(undefined);
    pendingMessageIdsRef.current.clear();
    pendingBashOutputsRef.current = [];
    askUserService.cancelAll('session cleared');
    getDefaultImageStore().clear();
    setEntries([]);
    setStatus('ready');
  }, [
    askUserService,
    invalidateHarness,
  ]);

  // On unmount, tear down LSP server subprocesses. The harness-owned dispose is
  // a no-op when the TUI owns the service; the service dispose below actually
  // kills subprocesses. A .catch is fine because the process is exiting — we
  // just don't want to leak zombies.
  useEffect(
    () => () => {
      const dispose = harnessDisposeRef.current;
      harnessDisposeRef.current = null;
      if (dispose) {
        dispose().catch(() => {});
      }
      const service = lspServiceRef.current;
      lspServiceRef.current = null;
      if (service) {
        service.dispose().catch(() => {});
      }
    },
    [],
  );

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

  const handleStop = useCallback(async (): Promise<void> => {
    const harness = harnessRef.current;
    if (!harness) {
      return;
    }
    const wasGenerating =
      harness.getStatus({
        threadId: threadIdRef.current,
      }).kind === 'generating';
    await harness.abort({
      threadId: threadIdRef.current,
      reason: 'user-requested',
    });
    // If the agent was mid-tool waiting on the user, kill the dialog and let
    // the abort propagate the cancelled error back to the model.
    askUserService.cancelAll('user stopped turn');
    if (!wasGenerating) {
      return;
    }
    setEntries((prev) => [
      ...prev,
      {
        role: 'system',
        type: 'info',
        content: 'Canceled by user',
      } satisfies SystemEntry,
    ]);
  }, [
    askUserService,
  ]);

  const handleGracefulExit = useCallback(async (): Promise<void> => {
    const harness = harnessRef.current;
    if (harness) {
      try {
        await harness.abort({
          threadId: threadIdRef.current,
          reason: 'user-requested',
        });
      } catch {
        // best-effort: harness teardown may already be in progress
      }
    }
    askUserService.cancelAll('user exit');
    onRequestExit();
  }, [
    askUserService,
    onRequestExit,
  ]);

  const exitInterruptStatus: ExitActionStatus =
    modal !== null ? 'modal' : status === 'streaming' || status === 'submitted' ? status : 'idle';

  const { isHintArmed: exitHintArmed } = useExitOnInterrupt({
    status: exitInterruptStatus,
    inputBufferEmpty: true,
    doublePressWindowMs: config.ui?.doublePressWindowMs,
    enabledKeys: [
      'ctrl-c',
    ],
    onAbortTurn: handleStop,
    onExitGracefully: handleGracefulExit,
  });

  /** Run a `cd` in-process and update the session-scoped `effectiveCwd`. */
  const runCd = useCallback((command: string): void => {
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
    // Single source of truth: the harness's `rootCwdState` is what the
    // agent's tools (Bash, Read, Write, ...) will read on their next call.
    harnessRef.current?.setRootCwd(result.newCwd);
    pendingBashOutputsRef.current.push(buildCdBashResult(command, result.newCwd));

    const extras: SystemEntry[] = [];
    extras.push(buildCdEntry(result.newCwd));
    if (!cdNoticeShownRef.current) {
      cdNoticeShownRef.current = true;
      extras.push(buildCdSplitNoticeEntry());
    }
    setEntries((prev) => [
      ...prev,
      ...extras,
    ]);
  }, []);

  /** Execute a `!` or auto-detected command locally, append transcript
   *  entry, and stash the result for the next agent turn. */
  const runLocalBash = useCallback(
    async (command: string): Promise<void> => {
      if (getFirstCommand(command) === 'cd') {
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

  // Context Split View — `/context` toggles the dock. When opening fresh,
  // start with focus on chat so the user can keep typing. See spec 28.
  const toggleContextPanel = useCallback((): void => {
    setContextPanelOpen((prev) => {
      if (prev) {
        // Closing the dock — restore chat focus so a future re-open (or any
        // gate using focusedPane) starts from a sensible state.
        setFocusedPane('chat');
        return false;
      }
      setFocusedPane('chat');
      return true;
    });
  }, []);

  const swapContextFocus = useCallback((): void => {
    setFocusedPane((prev) => nextFocus(prev));
  }, []);

  // When AskUserModal opens while the dock is open, snap focus back to
  // chat so the user can answer. The dock stays mounted.
  useEffect(() => {
    if (askUserRequest && contextPanelOpen) {
      setFocusedPane('chat');
    }
  }, [
    askUserRequest,
    contextPanelOpen,
  ]);

  // Resolve the configured panel width (or default 'responsive').
  const panelWidthConfig: ContextPanelWidthConfig = config.ui?.contextPanelWidth ?? 'responsive';

  const handleSubmit = useCallback(
    async (message: PromptInputMessage): Promise<void> => {
      // Ephemeral notices clear on the next user submission so they don't
      // linger across turns.
      setStatusNotice(null);
      const text = message.text;
      // Auto-open the Context dock on the user's FIRST real prompt — anything
      // that isn't a slash command. Skipping `/foo` matches user
      // expectation: the dock is about the LLM context breakdown, so
      // showing it only kicks in once the user actually engages the model.
      // One-shot via the ref so a manual close later sticks.
      if (
        !hasAutoOpenedContextPanelRef.current &&
        text.trim().length > 0 &&
        !text.trim().startsWith('/')
      ) {
        hasAutoOpenedContextPanelRef.current = true;
        setContextPanelOpen(true);
        // Keep focus on chat so the user can keep typing — the dock just
        // appears alongside.
        setFocusedPane('chat');
      }
      const sendUserMessage = async (
        messageText: string,
        contentParts?: ReadonlyArray<InputContentPart>,
      ): Promise<void> => {
        // Snapshot pending bash outputs now so any `!cmd` the user runs during
        // the agent turn falls through to the NEXT flush instead of being
        // dropped here.
        const pendingSnapshot: ReadonlyArray<LocalBashResult> = [
          ...pendingBashOutputsRef.current,
        ];
        const augmented = augmentTextWithPendingBash(messageText, pendingSnapshot);
        const input =
          contentParts === undefined
            ? augmented
            : ({
                id: `user-${crypto.randomUUID()}`,
                type: 'message',
                role: 'user',
                status: 'completed',
                content: [
                  {
                    type: 'input_text',
                    text: augmented,
                  },
                  ...contentParts.filter((part) => part.type !== 'input_text'),
                ],
              } satisfies InputMessageItem);
        try {
          const harness = await getOrCreateHarness(agentMode, model);
          const isBusy =
            harness.getStatus({
              threadId: threadIdRef.current,
            }).kind !== 'idle';
          const messageId = `msg-${crypto.randomUUID()}`;
          const userEntry: UserEntry = {
            role: 'user',
            content: messageText,
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

          await harness.execute(input, {
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
      };

      const appendUnknownCommand = (): void => {
        setEntries((prev) => [
          ...prev,
          {
            role: 'system',
            type: 'error',
            content: `Unknown command: ${text}`,
          } satisfies ErrorEntry,
        ]);
      };

      const bashCommand = parseBashCommand(text);
      if (bashCommand !== null) {
        await runLocalBash(bashCommand);
        return;
      }

      const resolvedAttachments = await resolvePromptAttachments({
        text,
        cwd: effectiveCwdRef.current,
      });
      if (resolvedAttachments.errors.length > 0) {
        setEntries((prev) => [
          ...prev,
          ...resolvedAttachments.errors.map(
            (content): ErrorEntry => ({
              role: 'system',
              type: 'error',
              content,
            }),
          ),
        ]);
      }
      const hasAttachments =
        resolvedAttachments.attachments.length > 0 || message.attachments.length > 0;

      if (!isSlashCommand(text) || hasAttachments) {
        await sendUserMessage(text, hasAttachments ? resolvedAttachments.contentParts : undefined);
        return;
      }

      const parsed = parseSlashCommand(text);
      if (!parsed) {
        appendUnknownCommand();
        return;
      }
      const cmd = findCommand(parsed.commandName, commands);
      if (!cmd) {
        appendUnknownCommand();
        return;
      }

      const activatedSkills = extractActivatedSkills(entriesRef.current);
      const ctx: CommandContext = {
        config: {
          ...config,
          model,
        },
        cwd: config.cwd,
        harness: harnessRef.current ?? undefined,
        askUserService,
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
        sessionSnapshot: buildSessionSnapshot(entriesRef.current),
        setCustomTitle,
        setTag,
        clearSession,
        restartWithSession,
        setViewMode,
        toggleContextPanel,
        contextPanelOpen,
      };

      try {
        const result = await executeCommand({
          command: cmd,
          args: parsed.args,
          ctx,
          options: {
            onJsxComplete: (summary) => {
              setModal(null);
              if (summary === undefined) {
                return;
              }
              if (typeof summary === 'string') {
                if (summary.length > 0) {
                  setEntries((prev) => [
                    ...prev,
                    {
                      role: 'system',
                      type: 'info',
                      content: summary,
                    } satisfies SystemEntry,
                  ]);
                }
                return;
              }
              if (summary.type === 'prompt') {
                void sendUserMessage(summary.value);
              }
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
          return;
        }
        if (result.type === 'notice') {
          setStatusNotice(result.value);
          return;
        }
        if (result.type === 'modal') {
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
          return;
        }
        if (result.type === 'prompt') {
          await sendUserMessage(result.value);
          return;
        }
      } catch (error) {
        setEntries((prev) => [
          ...prev,
          buildErrorEntry(error),
        ]);
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
      buildSessionSnapshot,
      setCustomTitle,
      setTag,
      askUserService,
      restartWithSession,
      clearSession,
      toggleContextPanel,
      contextPanelOpen,
    ],
  );

  const footerValue = useMemo<FooterContext>(
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

  const handleToggleAgentMode = useCallback((): void => {
    const next: AgentMode = agentMode === 'planning' ? 'act' : 'planning';
    setAgentMode(next).catch(() => {});
  }, [
    agentMode,
    setAgentMode,
  ]);

  // Stable identity so the request-items overlay doesn't refetch on every parent
  // render while open; reads through the refs each invocation.
  const getRequestItems = useCallback(
    async () =>
      harnessRef.current?.previewRequestItems({
        threadId: threadIdRef.current,
      }) ?? [],
    [],
  );

  const exitToChat = useCallback((): void => {
    // Snap focus back to the chat pane on view re-entry — if the user left
    // chat with the context pane focused, returning here would silently
    // leave the prompt un-typeable until they discovered Ctrl+W.
    setFocusedPane('chat');
    setViewMode({
      kind: 'chat',
    });
  }, []);

  /** Aborts an in-flight open-chat socket poll (never the planner spawn). */
  const openChatPollAbortRef = useRef<AbortController | null>(null);

  const exitSpawningView = useCallback((): void => {
    // Backing out of the spawning view cancels the POLL only — the planner
    // runner is durable and keeps starting up in the background.
    openChatPollAbortRef.current?.abort();
    openChatPollAbortRef.current = null;
    exitToChat();
  }, [
    exitToChat,
  ]);

  const handleOpenChat = useCallback(
    (task: { id: string }): void => {
      void (async (): Promise<void> => {
        const ctx = {
          fs: config.fs,
          projectRoot: config.cwd,
        };
        openChatPollAbortRef.current?.abort();
        const pollAbort = new AbortController();
        openChatPollAbortRef.current = pollAbort;
        let waited = false;
        const showSpawning = (): void => {
          waited = true;
          setViewMode({
            kind: 'taskChatSpawning',
            taskId: task.id,
          });
        };
        try {
          let harness = harnessRef.current;
          if (harness === null) {
            // Fresh session: the harness is created lazily on the first chat
            // message, so opening a task chat must bootstrap it here. Show
            // the spawning view immediately for feedback — creation takes a
            // while (skill catalog scan, plugin loads). Safe against
            // concurrent submits via the single-flight gate.
            showSpawning();
            harness = await getOrCreateHarness(agentMode, model);
          }
          const found = await ensureChatTarget(ctx, task.id, {
            subprocess: harness.subprocess,
            onSpawning: showSpawning,
            signal: pollAbort.signal,
          });
          setViewMode((current) =>
            resolveOpenChatTransition({
              current,
              taskId: task.id,
              waited,
              found,
            }),
          );
        } catch (error) {
          setViewMode({
            kind: 'taskBoard',
          });
          setEntries((prev) => [
            ...prev,
            buildErrorEntry(error),
          ]);
        }
      })();
    },
    [
      config.fs,
      config.cwd,
      getOrCreateHarness,
      agentMode,
      model,
    ],
  );

  return (
    <InkProvider>
      <FooterContextProvider value={footerValue}>
        <StreamMetricsProvider value={streamMetrics}>
          <RootCanvas>
            {viewMode.kind === 'taskBoard' ? (
              <TaskBoard
                fs={config.fs}
                projectRoot={config.cwd}
                onExit={exitToChat}
                onOpenChat={handleOpenChat}
              />
            ) : viewMode.kind === 'taskChat' ? (
              <TaskChatView
                socketPath={viewMode.socketPath}
                taskId={viewMode.taskId}
                roleLabel={viewMode.roleLabel}
                onExit={exitToChat}
              />
            ) : viewMode.kind === 'taskChatSpawning' ? (
              <TaskChatSpawningView taskId={viewMode.taskId} onExit={exitSpawningView} />
            ) : (
              <ChatLayout
                panelOpen={contextPanelOpen}
                focusedPane={focusedPane}
                onFocusSwap={swapContextFocus}
                onClosePanel={toggleContextPanel}
                panelWidthConfig={panelWidthConfig}
                modalActive={modal !== null || askUserRequest !== null}
                model={model}
                lastLayerUsage={lastLayerUsage}
                registeredLayers={memoryLayersRef.current}
                getRequestItems={getRequestItems}
                entries={entries}
                status={status}
              >
                {(overlayState) => (
                  <ResponsesChat
                    entries={entries}
                    status={status}
                    onSubmit={handleSubmit}
                    onStop={handleStop}
                    model={model}
                    agentMode={agentMode}
                    onToggleMode={handleToggleAgentMode}
                    commands={commandSuggestions}
                    modalContent={modal?.content}
                    onModalClose={handleModalClose}
                    plugins={plugins}
                    exitHintArmed={exitHintArmed}
                    overlay={overlayState.overlay}
                    requestItems={overlayState.requestItems}
                    requestItemsLoading={overlayState.requestItemsLoading}
                    isActive={!contextPanelOpen || focusedPane === 'chat'}
                    statusNotice={statusNotice}
                  />
                )}
              </ChatLayout>
            )}
          </RootCanvas>
        </StreamMetricsProvider>
      </FooterContextProvider>
    </InkProvider>
  );
}

//#endregion

//#region Entry Point

export interface RunAgentOptions {
  initialSession?: SessionFile | null;
  disablePersistence?: boolean;
  /** From `-n/--name`; overrides the saved `customTitle` when provided. */
  name?: string;
  /** From `--session-id`; forces a specific session id for a fresh session. */
  forcedSessionId?: string;
}

/**
 * Run the TUI until the user exits or restarts via `/resume`. Returns once
 * Ink unmounts for good (either by user Ctrl+D or after an explicit restart
 * leaves the loop with `initialSession` resolved to the new target).
 */
export async function runAgent(
  plugins: ReadonlyArray<NoeticPlugin>,
  config: AgentRuntimeConfig,
  options: RunAgentOptions = {},
): Promise<void> {
  let currentSession = options.initialSession ?? null;
  let currentName = options.name;

  // Loop so `/resume` can swap the session without quitting the process.
  while (true) {
    const outcome = await runOneSession({
      plugins,
      config,
      disablePersistence: options.disablePersistence ?? false,
      initialSession: currentSession,
      name: currentName,
      // Only apply --session-id to the initial session — after a /resume
      // swap, the loaded session's id wins (the fallback is never consulted).
      forcedSessionId: currentSession === null ? options.forcedSessionId : undefined,
    });
    if (outcome.kind === 'exit') {
      return;
    }
    if (outcome.kind === 'restart-file') {
      currentSession = outcome.file;
      currentName = undefined;
      continue;
    }
    // 'restart-picker' — render the picker, then loop back with the choice.
    const picked = await (await import('./run-picker.js')).runPicker(config.cwd);
    if (picked === null) {
      return;
    }
    currentSession = picked;
    currentName = undefined;
  }
}

type RunOneSessionOutcome =
  | {
      kind: 'exit';
    }
  | {
      kind: 'restart-file';
      file: SessionFile;
    }
  | {
      kind: 'restart-picker';
    };

interface RunOneSessionOpts {
  plugins: ReadonlyArray<NoeticPlugin>;
  config: AgentRuntimeConfig;
  disablePersistence: boolean;
  initialSession: SessionFile | null;
  name: string | undefined;
  forcedSessionId: string | undefined;
}

async function runOneSession(opts: RunOneSessionOpts): Promise<RunOneSessionOutcome> {
  return new Promise<RunOneSessionOutcome>((resolve) => {
    let resolved = false;
    const resolveOnce = (outcome: RunOneSessionOutcome): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(outcome);
    };

    const requestExit = (): void => {
      // The Ink instance has a guard so unmount() is idempotent. After
      // unmount, the waitUntilExit() promise below resolves and we report
      // a normal exit outcome.
      try {
        instance.unmount();
      } catch {
        // Already torn down — ignore.
      }
    };
    const instance = render(
      <App
        config={opts.config}
        plugins={opts.plugins}
        initialSession={opts.initialSession}
        disablePersistence={opts.disablePersistence}
        name={opts.name}
        forcedSessionId={opts.forcedSessionId}
        onRestart={(target) => {
          instance.unmount();
          resolveOnce(
            target.kind === 'file'
              ? {
                  kind: 'restart-file',
                  file: target.file,
                }
              : {
                  kind: 'restart-picker',
                },
          );
        }}
        onRequestExit={requestExit}
      />,
      {
        // Ink's default sends SIGINT and exits on Ctrl+C, which skips our
        // graceful abort + terminal restore. We own that path via
        // useExitOnInterrupt instead.
        exitOnCtrlC: false,
      },
    );
    const disposeSuspend = installSuspendResumeHandlers({
      on: (signal, handler) => {
        process.on(signal, handler);
      },
      off: (signal, handler) => {
        process.off(signal, handler);
      },
      raise: (signal) => {
        process.kill(process.pid, signal);
      },
      stdout: process.stdout,
      setRawMode:
        process.stdin.isTTY && typeof process.stdin.setRawMode === 'function'
          ? (raw) => process.stdin.setRawMode(raw)
          : undefined,
      onResume: () => {
        // Raw mode was already restored by the suspend-resume handler
        // (Ink's clear() only redraws output — it does NOT touch terminal
        // modes). All that's left is forcing a full repaint so the screen
        // content returns after `fg`.
        try {
          instance.clear();
        } catch {
          // Ink may have unmounted already; nothing to redraw.
        }
      },
    });

    instance.waitUntilExit().then(() => {
      disposeSuspend();
      resolveOnce({
        kind: 'exit',
      });
    });
  });
}

//#endregion
