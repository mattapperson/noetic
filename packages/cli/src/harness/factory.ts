import type {
  FsAdapter,
  MemoryLayer,
  PlanEnterSessionCallback,
  PlanExitCallback,
  ShellAdapter,
  Tool,
} from '@noetic/core';
import {
  AgentHarness,
  createLocalShellAdapter,
  durableTaskState,
  fileReference,
  observationalMemory,
  planMemory,
  step,
  toolMemoryLayer,
  workingMemory,
} from '@noetic/core';
import type { SystemPromptInputs } from '../ai/system-prompt.js';
import { composeSystemPrompt } from '../ai/system-prompt.js';
import { loadAgentInstructions } from '../config/agent-md-loader.js';
import { agentMdLayer } from '../memory/agent-md-layer.js';
import { reminderLayer } from '../memory/reminder-layer.js';
import type { ReminderTrigger } from '../memory/reminder-triggers.js';
import { BUILTIN_TRIGGERS, createReminderRegistry } from '../memory/reminder-triggers.js';
import { skillsLayer } from '../memory/skills-layer.js';
import type { PluginContextBuilder } from '../plugins/context.js';
import type { NoeticPlugin } from '../plugins/types.js';
import { buildSkillCatalog } from '../skills/catalog.js';
import type { SkillDefinition } from '../skills/types.js';
import { createActivateSkillTool, createCodingTools, createReadOnlyTools } from '../tools/index.js';
import type { AgentConfig } from '../types/config.js';

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
  skills: ReadonlyArray<SkillDefinition>;
  memoryLayers: ReadonlyArray<MemoryLayer>;
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
}

/**
 * Create the agent harness with all tools, memory layers, and skills.
 * Returns both the harness and the canonical skill catalog for UI use.
 */
export async function createAgentHarness(opts: CreateAgentHarnessOpts): Promise<HarnessWithSkills> {
  const { config, plugins, fs, buildContext } = opts;
  const shell = opts.shell ?? createLocalShellAdapter();
  const mode: AgentMode = opts.mode ?? 'normal';
  const planHooks = opts.planHooks;

  // Build canonical skill catalog (single source of truth)
  const allSkills = await buildSkillCatalog({
    cwd: config.cwd,
    plugins,
    fs,
    buildCtx: buildContext,
  });

  // Build tools including skill activation. In planning mode we hide mutating
  // tools from the model entirely; planMemory.beforeToolCall remains as defense-in-depth.
  const builtinTools =
    mode === 'planning'
      ? createReadOnlyTools(config.cwd, fs, shell)
      : createCodingTools(config.cwd, fs, shell);
  const pluginTools = await collectPluginTools(plugins, buildContext);
  const activateSkill = allSkills.length > 0 ? createActivateSkillTool(allSkills) : null;

  const tools = filterTools(
    [
      ...builtinTools,
      ...pluginTools,
      ...(activateSkill
        ? [
            activateSkill,
          ]
        : []),
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

  const memory: MemoryLayer[] = [
    reminderLayer({
      registry: reminderRegistry,
    }),
    planMemory({
      additionalPlanInstructions,
      onEnterSession: planHooks?.onEnterSession,
      onExit: planHooks?.onExit,
    }),
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
  ];

  const isGitRepo = await detectIsGitRepo(fs, config.cwd);
  const instructions = composeBaseInstructions(config, {
    cwd: config.cwd,
    platform: process.platform,
    shell: process.env.SHELL ?? 'unknown',
    sessionDate: new Date().toISOString(),
    model: config.model,
    isGitRepo,
    userOverrideIntro: config.systemPromptMode === 'replace' ? undefined : config.systemPrompt,
    mode,
  });

  const harness = new AgentHarness({
    name: 'noetic-cli',
    fs,
    shell,
    params: {
      model: config.model,
    },
    initialStep: step.llm({
      id: 'chat',
      model: config.model,
      instructions,
      tools,
    }),
    memory,
    llm: {
      provider: 'openrouter',
      apiKey: config.apiKey,
    },
  });

  return {
    harness,
    skills: allSkills,
    memoryLayers: memory,
  };
}

//#endregion
