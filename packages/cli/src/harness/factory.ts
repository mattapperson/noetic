import { createCodeAgent } from '@noetic/code-agent';
import { TeammateRegistry } from '@noetic/code-agent/agents';
import type { AskUserService } from '@noetic/code-agent/ask-user-service';
import type { LspServerContribution } from '@noetic/code-agent/lsp';
import { createBuiltinLspServers, LspService } from '@noetic/code-agent/lsp';
import type { ReminderTrigger } from '@noetic/code-agent/memory';
import {
  agentMdLayer,
  BUILTIN_TRIGGERS,
  createReminderRegistry,
  createSteeringFileLayer,
  reminderLayer,
  skillsLayer,
  teammateInboxLayer,
} from '@noetic/code-agent/memory';
import type { PluginContextBuilder } from '@noetic/code-agent/plugins';
import type { SkillDefinition } from '@noetic/code-agent/skills';
import { buildSkillCatalog } from '@noetic/code-agent/skills';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { resolveSubprocessRoot } from '@noetic/code-agent/tasks/store/fs-node';
import {
  createActivateSkillTool,
  createAgentTool,
  createCheckAgentTool,
  createCodingTools,
  createReadOnlyTools,
  createSendMessageTool,
} from '@noetic/code-agent/tools/node';
import type {
  AgentHarness,
  FsAdapter,
  MemoryLayer,
  PlanEnterSessionCallback,
  PlanExitCallback,
  ShellAdapter,
  StorageAdapter,
  SubprocessAdapter,
  Tool,
} from '@noetic/core';
import {
  createFileStorage,
  createLocalSubprocessAdapter,
  durableTaskState,
  fileReference,
  historyWindow,
  observationalMemory,
  planMemory,
  toolMemoryLayer,
  workingMemory,
} from '@noetic/core';
import type { SystemPromptInputs } from '../ai/system-prompt.js';
import { composeSystemPrompt } from '../ai/system-prompt.js';
import { createTaskMutationPolicy } from '../commands/builtins/tasks/mutation-policy.js';
import { taskTools } from '../commands/builtins/tasks/tools.js';
import { loadAgentInstructions } from '../config/agent-md-loader.js';
import type { NoeticPlugin } from '../plugins/types.js';
import type { AgentConfig } from '../types/config.js';
import { createDefaultShellAdapter } from './shell-adapter-bootstrap.js';

//#region Types

export type AgentMode = 'normal' | 'planning';

export interface PlanHooks {
  onEnterSession?: PlanEnterSessionCallback;
  onExit?: PlanExitCallback;
  additionalPlanInstructions?: string;
}

//#endregion

//#region Helpers

async function collectPluginTools(
  plugins: ReadonlyArray<NoeticPlugin>,
  buildCtx: PluginContextBuilder,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const plugin of plugins) {
    const pluginTools = await plugin.tools?.(buildCtx(plugin.name));
    if (!pluginTools) {
      continue;
    }
    tools.push(...pluginTools);
  }
  return tools;
}

async function collectPluginMemory(
  plugins: ReadonlyArray<NoeticPlugin>,
  buildCtx: PluginContextBuilder,
): Promise<MemoryLayer[]> {
  const layers: MemoryLayer[] = [];
  for (const plugin of plugins) {
    const memoryLayers = await plugin.memoryLayers?.(buildCtx(plugin.name));
    if (!memoryLayers) {
      continue;
    }
    layers.push(...memoryLayers);
  }
  return layers;
}

async function collectPluginReminderTriggers(
  plugins: ReadonlyArray<NoeticPlugin>,
  buildCtx: PluginContextBuilder,
): Promise<ReminderTrigger[]> {
  const triggers: ReminderTrigger[] = [];
  for (const plugin of plugins) {
    const provided = await plugin.reminderTriggers?.(buildCtx(plugin.name));
    if (!provided) {
      continue;
    }
    triggers.push(...provided);
  }
  return triggers;
}

async function collectPluginLspServers(
  plugins: ReadonlyArray<NoeticPlugin>,
  buildCtx: PluginContextBuilder,
): Promise<LspServerContribution[]> {
  const servers: LspServerContribution[] = [];
  for (const plugin of plugins) {
    const provided = await plugin.lspServers?.(buildCtx(plugin.name));
    if (!provided) {
      continue;
    }
    servers.push(...provided);
  }
  return servers;
}

export interface CreateLspServiceOpts {
  plugins: ReadonlyArray<NoeticPlugin>;
  buildCtx: PluginContextBuilder;
  cwd: string;
  fs: FsAdapter;
}

/**
 * Build a ready-to-use `LspService` from builtins + plugin contributions.
 * Call this once at TUI mount time and pass the result into every
 * `createAgentHarness` call via `opts.lspService` so language-server processes
 * survive harness recreations (e.g. `/model`, `/plan` swaps).
 */
export async function createLspService(opts: CreateLspServiceOpts): Promise<LspService> {
  return new LspService({
    servers: [
      ...createBuiltinLspServers(),
      ...(await collectPluginLspServers(opts.plugins, opts.buildCtx)),
    ],
    cwd: opts.cwd,
    fs: opts.fs,
  });
}

async function detectIsGitRepo(fs: FsAdapter, cwd: string): Promise<boolean> {
  try {
    await fs.access(`${cwd}/.git`);
    return true;
  } catch {
    return false;
  }
}

function composeBaseInstructions(config: AgentConfig, inputs: SystemPromptInputs): string {
  if (config.systemPromptMode === 'replace' && config.systemPrompt !== undefined) {
    return config.systemPrompt;
  }
  return composeSystemPrompt(inputs);
}

function filterTools(allTools: Tool[], config: AgentConfig): Tool[] {
  const includes = new Set(config.tools?.include ?? []);
  const excludes = new Set(config.tools?.exclude ?? []);

  return allTools.filter((tool) => {
    if (includes.size > 0 && !includes.has(tool.name)) {
      return false;
    }
    if (excludes.has(tool.name)) {
      return false;
    }
    return true;
  });
}

//#endregion

//#region Public API

export interface HarnessWithSkills {
  harness: AgentHarness<{
    model: string;
  }>;
  /**
   * Subprocess adapter bound to the harness. Exposed so task launchers
   * and control surfaces (delete-guard, resolve-chat-target) can thread
   * the same adapter through — `findLiveTaskHandle` only sees handles
   * persisted via the same adapter's `StorageAdapter`, so a shared
   * instance is required.
   */
  subprocess: SubprocessAdapter;
  skills: ReadonlyArray<SkillDefinition>;
  memoryLayers: ReadonlyArray<MemoryLayer>;
  /** Tears down owned resources (LSP server processes, etc.). Safe to call multiple times. */
  dispose: () => Promise<void>;
  /**
   * The per-harness teammate registry. Exposed so callers (TUI, tests) can
   * call `teammates.dropAll()` during teardown to release detached-handle
   * references (the underlying executions continue until they settle —
   * `DetachedHandle` has no cancel API).
   */
  teammates: TeammateRegistry;
}

interface CreateAgentHarnessOpts {
  config: AgentConfig;
  plugins: ReadonlyArray<NoeticPlugin>;
  fs: FsAdapter;
  shell?: ShellAdapter;
  buildContext: PluginContextBuilder;
  /** Initial agent mode. Defaults to `'normal'`. */
  mode?: AgentMode;
  /** Optional plan-mode lifecycle hooks (session creation, approval gate, extra instructions). */
  planHooks?: PlanHooks;
  /**
   * Optional pre-built LSP service to share across harness recreations (e.g.
   * `/model` or `/plan` swaps). If omitted, a service is created from builtins
   * + plugin contributions and owned by this harness — its `dispose` is wired
   * to tear the service down.
   */
  lspService?: LspService;
  /**
   * Optional ask-user service, supplied by the TUI. When present, the
   * `AskUserQuestion` tool is registered and can pause mid-turn for user
   * input rendered as a modal. Headless harnesses omit it.
   */
  askUserService?: AskUserService;
}

/**
 * Create the agent harness with all tools, memory layers, and skills.
 * Returns both the harness and the canonical skill catalog for UI use.
 */
export async function createAgentHarness(opts: CreateAgentHarnessOpts): Promise<HarnessWithSkills> {
  const { config, plugins, fs, buildContext } = opts;
  const shell = opts.shell ?? createDefaultShellAdapter(config);
  const mode: AgentMode = opts.mode ?? 'normal';
  const planHooks = opts.planHooks;

  // Build canonical skill catalog (single source of truth)
  const allSkills = await buildSkillCatalog({
    cwd: config.cwd,
    plugins,
    fs,
    buildCtx: buildContext,
  });

  // If the caller passed an existing LspService, reuse it — language-server
  // subprocesses should survive harness recreations on /model and /plan swaps.
  // Otherwise build one and own its teardown.
  const ownedLspService: LspService | undefined =
    opts.lspService === undefined
      ? await createLspService({
          plugins,
          buildCtx: buildContext,
          cwd: config.cwd,
          fs,
        })
      : undefined;
  const lspService = opts.lspService ?? ownedLspService;

  // Build tools including skill activation. In planning mode we hide mutating
  // tools from the model entirely; planMemory.beforeToolCall remains as defense-in-depth.
  const pluginTools = await collectPluginTools(plugins, buildContext);
  const activateSkill = allSkills.length > 0 ? createActivateSkillTool(allSkills) : null;
  const taskCtx: TaskStoreContext = {
    fs,
    projectRoot: config.cwd,
  };
  const mutationPolicy = createTaskMutationPolicy({
    sessionCwd: config.cwd,
    shell,
    enforceOnCleanRepo: true,
    ctx: taskCtx,
  });

  // Tools resolve cwd from the executing context's `cwdState` at execution
  // time, so a single tool pool serves the parent and any worktree-isolated
  // child. The factory `cwd` here is just the fallback for contexts without
  // a `cwdState` (test scaffolds).
  const builtin =
    mode === 'planning'
      ? createReadOnlyTools({
          cwd: config.cwd,
          fs,
          shell,
          lspService,
          askUserService: opts.askUserService,
          mutationPolicy,
        })
      : createCodingTools({
          cwd: config.cwd,
          fs,
          shell,
          lspService,
          askUserService: opts.askUserService,
          mutationPolicy,
        });
  // Built-in `task_*` tools are default-on. Users opt out via
  // `tools.tasks: false` in their noetic.config.ts. In planning mode we
  // hand the read-only subset (`task_show`, `task_list`, `task_logs`) so
  // the model can still observe the kanban without mutating it.
  const tasksOptIn = config.tools?.tasks !== false;
  const builtinTaskTools: ReadonlyArray<Tool> = tasksOptIn
    ? taskTools({
        ctx: taskCtx,
        readOnly: mode === 'planning',
      })
    : [];

  const baseTools: Tool[] = [
    ...builtin,
    ...builtinTaskTools,
    ...pluginTools,
    ...(activateSkill
      ? [
          activateSkill,
        ]
      : []),
  ];

  // Per-harness teammate registry. Holds detached handles (by id), named
  // teammate inboxes (for `sendMessage`), and the parent-notice queue
  // drained by `teammateInboxLayer`.
  const teammates = new TeammateRegistry();

  // Sub-agents receive baseTools only (no agent/sendMessage/checkAgent) —
  // teammates cannot recursively spawn teammates unless a custom skill
  // allowlist explicitly includes 'agent'.
  const teammateTools: Tool[] = [
    createAgentTool({
      catalog: allSkills,
      teammates,
      parentTools: baseTools,
      parentModel: config.model,
      worktreeConfig: config.worktree,
      cwd: config.cwd,
      historyMaxItems: config.history?.maxItems,
      agentOverrides: config.agents,
    }),
    createSendMessageTool({
      teammates,
    }),
    createCheckAgentTool({
      teammates,
    }),
  ];

  const tools = filterTools(
    [
      ...baseTools,
      ...teammateTools,
    ],
    config,
  );

  // Build memory layers including plan and skills layers
  const pluginMemory = await collectPluginMemory(plugins, buildContext);

  // Load AGENT.md + rules once per harness construction. Layer caches the result
  // in state via `scope: 'execution'`, so this doesn't re-read per turn.
  const agentInstructions = await loadAgentInstructions({
    cwd: config.cwd,
    fs,
    shell,
    trustProjectEmbeddedCommands: config.trustProjectEmbeddedCommands === true,
  });

  // Assemble the reminder registry: built-ins + plugin-contributed triggers.
  const reminderRegistry = createReminderRegistry();
  for (const trigger of BUILTIN_TRIGGERS) {
    reminderRegistry.register(trigger);
  }
  const pluginTriggers = await collectPluginReminderTriggers(plugins, buildContext);
  for (const trigger of pluginTriggers) {
    reminderRegistry.register(trigger);
  }

  // The built-in (or user-overridden) `plan-mode` skill carries detailed
  // authoring guidance for plan.md PRDs and FlowSchema plan-trees. Inject its
  // content as additional plan instructions so it's in context from turn one
  // of plan mode, concatenated with any host-supplied instructions.
  const planModeSkill = allSkills.find((s) => s.name === 'plan-mode');
  const planInstructionBlocks: string[] = [];
  if (planModeSkill) {
    planInstructionBlocks.push(planModeSkill.instructions);
  }
  if (planHooks?.additionalPlanInstructions) {
    planInstructionBlocks.push(planHooks.additionalPlanInstructions);
  }
  const additionalPlanInstructions =
    planInstructionBlocks.length > 0 ? planInstructionBlocks.join('\n\n---\n\n') : undefined;

  const historyMaxItems = config.history?.maxItems;

  // Steering-file layer is gated on the `NOETIC_TASK_DIR` env var, which the
  // task launcher sets when spawning agent-ci for a specific task. Non-task
  // agent runs leave the env unset, so we omit the layer entirely rather than
  // mounting a dormant one — keeps the layer list lean for the common case.
  const isTaskRun = (process.env.NOETIC_TASK_DIR ?? '').length > 0;

  const memory: MemoryLayer[] = [
    teammateInboxLayer({
      teammates,
    }),
    reminderLayer({
      registry: reminderRegistry,
    }),
    planMemory({
      additionalPlanInstructions,
      onEnterSession: planHooks?.onEnterSession,
      onExit: planHooks?.onExit,
    }),
    ...(isTaskRun
      ? [
          createSteeringFileLayer(),
        ]
      : []),
    workingMemory(),
    agentMdLayer({
      loader: () => Promise.resolve(agentInstructions),
    }),
    observationalMemory(),
    fileReference(),
    durableTaskState(),
    ...toolMemoryLayer(tools),
    ...pluginMemory,
    ...(allSkills.length > 0
      ? [
          skillsLayer(allSkills, {
            cwd: config.cwd,
          }),
        ]
      : []),
    ...(historyMaxItems !== undefined
      ? [
          historyWindow({
            maxItems: historyMaxItems,
          }),
        ]
      : []),
  ];

  const isGitRepo = await detectIsGitRepo(fs, config.cwd);
  const instructions = composeBaseInstructions(config, {
    cwd: config.cwd,
    platform: process.platform,
    shell: process.env.SHELL ?? 'unknown',
    model: config.model,
    isGitRepo,
    userOverrideIntro: config.systemPromptMode === 'replace' ? undefined : config.systemPrompt,
    mode,
  });

  // Subprocess handle manifests live under `<NOETIC_HOME>/subprocess`
  // (default `$HOME/.noetic/subprocess`) — distinct from the
  // `~/.noetic/checkpoints` default that `createFileStorage()` uses,
  // so task-runner identity and execution checkpoints don't share a
  // directory.
  const storage: StorageAdapter = createFileStorage({
    root: resolveSubprocessRoot(),
  });
  const subprocess: SubprocessAdapter = createLocalSubprocessAdapter({
    storage,
  });

  const codeAgent = await createCodeAgent({
    name: 'noetic-cli',
    model: config.model,
    cwd: config.cwd,
    adapters: {
      fs,
      shell,
      subprocess,
      storage,
    },
    tools,
    memory,
    instructions,
    defaultMemory: false,
    llm: {
      provider: 'openrouter',
      apiKey: config.apiKey,
    },
  });
  const harness = codeAgent.harness;

  return {
    harness,
    subprocess,
    skills: allSkills,
    memoryLayers: memory,
    // Only dispose the LSP service if we created it — a caller-supplied service
    // is owned by the caller and must outlive the harness.
    dispose: ownedLspService ? () => ownedLspService.dispose() : () => Promise.resolve(),
    teammates,
  };
}

//#endregion
