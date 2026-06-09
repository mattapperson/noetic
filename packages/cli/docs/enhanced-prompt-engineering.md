# Enhanced Prompt Engineering

The CLI provides memory layers that implement prompt engineering patterns adapted from Claude Code's system. These layers inject behavioral guidelines, tool usage instructions, communication style rules, environment context, and planning-mode guidance into the agent's context. They are layered on top of the core memory layers from `@noetic/memory` and live in `packages/cli/src/memory/`.

All layers use `Slot.PROCEDURAL` (250) execution scope with configured min/max token budgets. They are assembled in the harness factory at `src/harness/factory.ts` and activate automatically when the harness is created in `normal` or `planning` mode.

## Prompt Engineering Layer

Core behavioral guidelines with usage-pattern tracking and error-based adaptation.

**Source:** `src/memory/prompt-engineering-layer.ts`

| Property | Value |
|----------|-------|
| **id** | `prompt-engineering` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 200, max: 1000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

```typescript
function promptEngineeringLayer(): MemoryLayer<PromptEngineeringState>
```

**State:** Tracks current mode (`normal`/`planning`), tool usage frequencies (`Map<string, number>`), recent errors (up to 10), and an adapted communication style. No external dependencies.

**Behavior:**

- `init`: Initialises with empty usage patterns and no errors. Mode defaults to `normal`.
- `recall`: Injects core behavioral guidelines (communication efficiency rules, output style, focus areas). If tools have been used frequently, appends tool-usage reminders. If recent errors exist (within 5 minutes), appends error-recovery guidance.
- `store`: Increments per-tool call counters. Detects error signatures (`'error'`, `'failed'`, `'permission denied'`) in tool-result content following function-call items. Trims error history to the last 10 entries. Adapts communication style toward concise mode when total tool usage exceeds 20 calls.
- `onSpawn`: Clones tool patterns and communication style to child. Resets error history (spawned agents start with a clean slate).

## Communication Style Layer

Adaptive communication patterns based on user message analysis.

**Source:** `src/memory/communication-style-layer.ts`

| Property | Value |
|----------|-------|
| **id** | `communication-style` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 150, max: 500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

```typescript
function communicationStyleLayer(): MemoryLayer<CommunicationStyleState>
```

**State:** Tracks the current style (`concise`/`normal`/`verbose`), user preference flags (prefers explanations, prefers direct answers, asks technical questions), conversation metrics (message count, average length, question count), and last-update timestamp. No external dependencies.

**Behavior:**

- `init`: Sets style to `normal` with neutral preferences and zero metrics.
- `recall`: Renders style-specific communication guidelines and user preference notes. Concise mode skips reasoning; verbose mode provides detailed explanations.
- `store`: Extracts user message text from new items. Analyzes for question markers (`?`, leading wh-words/can-you phrases), technical keywords, explanation requests, and direct-answer indicators. Updates preference flags when 30%/40% thresholds are met. Adapts style: concise when direct-answer requests dominate and messages are short; verbose when explanation requests dominate or technical questions exceed 50% of recent messages.
- `onSpawn`: Clones style and preferences to child. Resets conversation metrics (spawned agents build their own history).

## Environment Context Layer

Dynamic environment detection providing platform, git, and capability context.

**Source:** `src/memory/environment-context-layer.ts`

| Property | Value |
|----------|-------|
| **id** | `environment-context` |
| **slot** | `Slot.OBSERVATIONS` (200) |
| **scope** | `execution` |
| **budget** | `{ min: 200, max: 800 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

```typescript
interface EnvironmentContextConfig {
  config: AgentConfig;
  shell: ShellAdapter;
}

function environmentContextLayer(config: EnvironmentContextConfig): MemoryLayer<EnvironmentContextState>
```

**Dependencies:** `AgentConfig` (for `cwd`), `ShellAdapter` (for environment detection).

**Environment detection** runs during `init` using the shell adapter:

- Platform: `process.platform`
- Git: `git rev-parse --is-inside-work-tree` and `git branch --show-current`
- Node.js: `node --version`
- Shell type: `echo $SHELL`
- Package manager: lock file detection (`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)
- Available commands: `command -v` checks for git, npm, yarn, pnpm, bun, curl, wget, jq, docker

All probes are run in parallel with individual 2-5s timeouts.

**Behavior:**

- `init`: Discovers environment info (parallel shell probes). Determines capabilities (git, package management, docker, HTTP, JSON processing). Stores as environment state.
- `recall`: Formats environment info into a structured context block including working directory, platform, git status, package manager, available commands, and platform-specific notes (macOS/Windows/Linux).
- `store`: Pass-through (environment is treated as static after init). Space reserved for periodic refresh.
- `onSpawn`: Clones environment context to child with updated timestamp.

## Tool Guidance Layer

Context-aware tool usage instructions with preference hierarchy and mode awareness.

**Source:** `src/memory/tool-guidance-layer.ts`

| Property | Value |
|----------|-------|
| **id** | `tool-guidance` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 300, max: 1200 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

```typescript
interface ToolGuidanceConfig {
  tools: ReadonlyArray<Tool>;
  mode?: 'normal' | 'planning';
}

function toolGuidanceLayer(config: ToolGuidanceConfig): MemoryLayer<ToolGuidanceState>
```

**State:** Tracks available tool names, current mode, and recent tool failures. Initialized from the config's tool list and mode.

**Behavior:**

- `init`: Seeds state with all tool names from the provided tool array. Sets mode from config (defaults to `normal`).
- `recall`: Assembles a tool-usage guidance block. When tools exist that match CLI conventions (Read, Edit, Write, Find, Grep, Bash), it emits a preference hierarchy ("Use Read tool, NOT cat/head/tail"). Adds file operation guidelines (read-before-edit, indentation preservation, absolute paths). In `planning` mode, adds plan-specific tool guidance. If agent delegation tools are available (`spawn`, `subagent`, `Agent`), adds delegation guidelines. If recent failures exist, appends troubleshooting reminders.
- `store`: Pass-through (failure tracking is a future enhancement; state passes through unchanged).
- `onSpawn`: Clones tool set and mode to child. Resets failure history.

## Planning Mode Layer

Specialized guidance for plan-mode operations with FlowSchema integration.

**Source:** `src/memory/planning-mode-layer.ts`

| Property | Value |
|----------|-------|
| **id** | `planning-mode` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 400, max: 1500 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

```typescript
interface PlanningModeConfig {
  availableTools: ReadonlyArray<Tool>;
  currentMode: 'normal' | 'planning';
}

function planningModeLayer(config: PlanningModeConfig): MemoryLayer<PlanningModeState>
```

**State:** Tracks whether planning mode is active, the current planning phase (`exploration`/`authoring`/`review`), active PRD references, FlowSchema node descriptions, and exploration progress (files examined, components identified, requirements gathered).

**Behavior:**

- `init`: Sets `isActive` from `currentMode`. Defaults to `exploration` phase with empty progress.
- `recall`: Returns `null` when not active. When active, returns a structured plan-mode context block containing: mode header and transition instructions, FlowSchema node type guidelines (llm, subagent, fork, spawn, sequence), PRD authoring best practices with `plan.md` template, tool usage guidance filtered by plan-mode appropriate tools, phase-specific objectives and recommendations, exploration progress summary with next-step recommendations.
- `store`: Updates exploration progress by counting Read function calls. Transitions phase automatically: exploration to authoring after 10 files examined; authoring to review when PRDs exist. Returns state unchanged if not active.
- `onSpawn`: Clones planning state to child. Resets exploration progress.

## Enhanced Skills Layer

Skills layer with integrated behavioral guidelines and progressive disclosure.

**Source:** `src/memory/skills-layer.ts`

| Property | Value |
|----------|-------|
| **id** | `skills-memory` |
| **slot** | `Slot.PROCEDURAL` (250) |
| **scope** | `execution` |
| **budget** | `{ min: 300, max: 2000 }` |
| **hooks** | `init`, `recall`, `store`, `onSpawn` |

```typescript
interface SkillsLayerConfig {
  cwd: string;
}

function skillsLayer(
  skills: SkillDefinition[],
  config: SkillsLayerConfig,
): MemoryLayer<SkillsLayerState>
```

**State:** Maintains skill definitions, list of activated skill names, and a processed-instruction cache (LRU, max 50 entries). Processed instructions are expanded inline shell commands (`!`) evaluated at activation time.

**Behavior:**

- `init`: Loads skill definitions into state. No skills are activated at start.
- `recall`: When skills are defined but none activated, renders an `<available_skills>` block listing each skill's name, description, when-to-use guidance, and the `activateSkill` prompt. When skills are activated, additionally injects behavioral guidelines (communication style, tool usage hierarchy, file operation rules, progress update rules) and each activated skill's full processed instructions.
- `store`: Detects `activateSkill` function calls via `findFunctionCall`. Validates the target skill exists and is model-invocable. Processes instructions (expanding inline shell commands using `processSkillContent`) and caches the result. Maintains LRU eviction when cache exceeds `MAX_CACHE_SIZE` (50).
- `onSpawn`: Clones definitions, activated skills, and processed instruction cache to child.

## Harness Factory Integration

The layers are assembled in `src/harness/factory.ts` in this order:

```
Core layers:           planMemory, workingMemory, observationalMemory
Enhanced layers:       promptEngineeringLayer, communicationStyleLayer,
                       environmentContextLayer(config, shell),
                       toolGuidanceLayer(tools, mode)
Mode-specific:         planningModeLayer(tools, mode) [only when mode=planning]
Existing layers:       fileReference, durableTaskState, toolMemoryLayer, plugin layers
Skills:                skillsLayer(skills, cwd) [only when skills exist]
```

Mode switching between `normal` and `planning` is controlled by the `/plan` CLI command. The `planningModeLayer` activates only in planning mode; the `toolGuidanceLayer` includes mode-appropriate guidance for either mode.

## Export

All layers are exported from `src/memory/index.ts`:

```typescript
export { communicationStyleLayer } from './communication-style-layer.js';
export { environmentContextLayer } from './environment-context-layer.js';
export { planningModeLayer } from './planning-mode-layer.js';
export { promptEngineeringLayer } from './prompt-engineering-layer.js';
export { skillsLayer } from './skills-layer.js';
export { toolGuidanceLayer } from './tool-guidance-layer.js';
```

## Future Considerations

- **Plugin contributions**: Allow plugins to register their own prompt engineering layers through the plugin system.
- **Session persistence**: Persist learned patterns (communication style preferences, tool usage frequencies) across CLI sessions.
- **Periodic environment refresh**: Re-run environment detection periodically (or on workspace change) rather than once at init.