/**
 * Root TUI application — Ink-rendered interactive agent loop.
 */

import type {
  AgentHarness,
  Item,
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
import type { TeammateRegistry } from '../agents/registry-runtime.js';
import { ensureTasksDaemon } from '../commands/builtins/tasks/daemon.js';
import {
  BUILTIN_COMMANDS,
  commandsToPromptSuggestions,
  executeCommand,
  findCommand,
  isSlashCommand,
  parseBashCommand,
  parseSlashCommand,
} from '../commands/index.js';
import type {
  Command,
  CommandContext,
  SessionRestartTarget,
  SessionSnapshot,
} from '../commands/types.js';
import type { AgentMode, PlanHooks } from '../harness/factory.js';
import { createAgentHarness, createLspService } from '../harness/factory.js';
import type { LspService } from '../lsp/service.js';
import { createPlanSession, writeFlow, writePrd } from '../plan/file-store.js';
import { createPluginContextBuilder } from '../plugins/context.js';
import type { FooterContext, NoeticPlugin } from '../plugins/types.js';
import type { SaveResult } from '../sessions/store.js';
import { saveSession } from '../sessions/store.js';
import { stripUnresolvedToolCalls } from '../sessions/strip-unresolved.js';
import type { SessionFile } from '../sessions/types.js';
import { buildSkillCatalog } from '../skills/catalog.js';
import type { SkillDefinition } from '../skills/types.js';
import type { AskUserOutput } from '../tools/ask-user-types.js';
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
import { AskUserModal } from './components/ask-user/index.js';
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
import type { PendingAskUserRequest } from './services/ask-user-service.js';
import { createAskUserService } from './services/ask-user-service.js';
import type { LiveTokens, StreamMetricsRefs } from './stream-metrics-context.js';
import { StreamMetricsProvider } from './stream-metrics-context.js';
import { getDefaultImageStore } from './utils/image-store.js';

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

/**
 * On resume, strip `deliveryStatus: 'queued'` from restored UserEntries —
 * a queued message was either delivered (followed by assistant items) or
 * will never be delivered now that the session is loading fresh. Treat it
 * as sent so the UI doesn't claim it's still pending forever.
 */
function normalizeEntriesForResume(raw: ReadonlyArray<ConversationEntry>): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const entry of raw) {
    if (isUserEntry(entry) && entry.deliveryStatus === 'queued') {
      const next: UserEntry = {
        ...entry,
        deliveryStatus: 'sent',
      };
      out.push(next);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Derive the first user message's text, truncated. Returns empty string if none. */
function deriveFirstPrompt(entries: ReadonlyArray<ConversationEntry>): string {
  for (const entry of entries) {
    if (isUserEntry(entry)) {
      return entry.content.length > 200 ? `${entry.content.slice(0, 200)}…` : entry.content;
    }
  }
  return '';
}

/** Count distinct user messages. */
function countUserMessages(entries: ReadonlyArray<ConversationEntry>): number {
  let n = 0;
  for (const entry of entries) {
    if (isUserEntry(entry)) {
      n += 1;
    }
  }
  return n;
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
  /** Called once per turn_completed/turn_aborted with the latest response. No-op if persistence is disabled. */
  onTurnSettled: (resp: {
    items: ReadonlyArray<Item>;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    };
    cost?: number;
    lastLayerUsage: LastLayerUsage | undefined;
  }) => void;
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
          opts.onTurnSettled({
            items: resp.items,
            usage: resp.usage,
            cost: resp.cost,
            lastLayerUsage: resp.lastLayerUsage,
          });
        } catch {
          // getAgentResponse can only reject if no session exists; here it does.
        }
        // Trust the runner's kind: if the next turn is already running
        // ('generating'), its turn_started will bounce us back to 'streaming';
        // otherwise we're genuinely idle and can accept input again.
        const runnerStatus = opts.harness.getStatus({
          threadId: opts.threadId,
        });
        if (runnerStatus.kind === 'generating') {
          opts.setStatus('streaming');
        } else {
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

function App({
  config,
  plugins,
  initialSession,
  disablePersistence,
  name,
  forcedSessionId,
  onRestart,
}: AppProps): ReactNode {
  useEffect(() => {
    try {
      ensureTasksDaemon(config.cwd);
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
  const [agentMode, setAgentModeState] = useState<AgentMode>(initialSession?.agentMode ?? 'normal');
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
  // Owned by the TUI (not the harness) so language-server subprocesses survive
  // /model and /plan swaps, which recreate the harness.
  const lspServiceRef = useRef<LspService | null>(null);
  const harnessModeRef = useRef<AgentMode>(initialSession?.agentMode ?? 'normal');
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

  const clearSession = useCallback(() => {
    // Full session reset: everything a `noetic --resume` would rebuild, plus UI.
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
    harnessRef.current = null;
    streamWiredHarnessRef.current = null;
    pendingMessageIdsRef.current.clear();
    pendingBashOutputsRef.current = [];
    askUserService.cancelAll('session cleared');
    getDefaultImageStore().clear();
    setEntries([]);
    setStatus('ready');
  }, [
    askUserService,
  ]);

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
        },
      });
    },
    [
      streamMetrics,
      persistSession,
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
    },
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
      const sendUserMessage = async (messageText: string): Promise<void> => {
        // Snapshot pending bash outputs now so any `!cmd` the user runs during
        // the agent turn falls through to the NEXT flush instead of being
        // dropped here.
        const pendingSnapshot: ReadonlyArray<LocalBashResult> = [
          ...pendingBashOutputsRef.current,
        ];
        const augmented = augmentTextWithPendingBash(messageText, pendingSnapshot);
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

      if (!isSlashCommand(text)) {
        await sendUserMessage(text);
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
        restartWithSession: onRestart,
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
      clearSession,
      onRestart,
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
      />,
    );
    instance.waitUntilExit().then(() => {
      resolveOnce({
        kind: 'exit',
      });
    });
  });
}

//#endregion
