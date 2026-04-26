# Editable Config TUI Plan

## Goal

Update the existing `/config` TUI from a read-only configuration viewer into an editable, validated configuration editor that can safely write changes back to the discovered Noetic config file.

The current implementation lives in `packages/cli/src/commands/builtins/config.tsx` and already provides:

- Tab navigation for Model, Tools & Plugins, Memory, Runtime, and Worktree settings
- Read-only rendering of `AgentConfig`
- Initial tab selection from `/config <tab>` arguments
- Escape-to-close behavior

This plan keeps the current tab-based UI and adds editing, validation, dirty-state tracking, and explicit save/cancel flows.

## User Experience

### Modes

The config TUI has two interaction modes:

1. **Navigate mode**
   - Switch tabs
   - Move between editable fields
   - View help text and validation messages

2. **Edit mode**
   - Edit the currently focused field
   - Confirm or cancel the field edit
   - Return to navigate mode after committing the in-memory value

### Keybindings

| Key | Behavior |
| --- | --- |
| `Tab` / `Shift+Tab` | Switch tabs when tab header is focused, otherwise move field focus |
| `←` / `→` | Switch tabs when tab header is focused |
| `↑` / `↓` | Move between fields inside a tab |
| `Enter` | Edit the focused field or confirm edit |
| `Esc` | Cancel edit, or close with unsaved-change confirmation |
| `s` | Save valid dirty config |
| `r` | Reset focused field to original value |
| `R` | Reset all changes after confirmation |
| `?` | Toggle help panel |

### Status Bar

Replace the current read-only footer with a persistent status bar:

- Shows current mode: `Navigate`, `Edit`, `Invalid`, `Saving`, `Saved`
- Shows dirty state: `Unsaved changes` when applicable
- Shows shortcuts relevant to the current mode
- Shows config source path when available

### Unsaved Changes

If the user presses `Esc` with unsaved changes, show a confirmation prompt:

- `Save and close`
- `Discard changes`
- `Keep editing`

The TUI should never silently discard edits.

## Configuration Source

### Current Gap

`ConfigViewer` receives only `ctx.config`, not the source path from config discovery. Editing needs the original file path so changes can be written back.

### Required Change

Thread config source metadata into the command context or provide a config service that exposes:

```typescript
interface EditableConfigSource {
  config: AgentConfig;
  sourcePath: string;
}
```

If no config file exists, `/config` should offer to create one at the project default path:

```text
./noetic.config.ts
```

Creation should be explicit and confirmed by the user.

## Editable Fields

### Phase 1 Editable Fields

Start with fields that map cleanly to serializable config values:

#### Model Tab

- `model`: text input
- `apiKey`: masked text input
- `maxTurns`: positive integer input
- `systemPromptMode`: select input with `compose` / `replace`
- `systemPrompt`: multiline text editor

#### Runtime Tab

- `cwd`: path text input
- `trustProjectEmbeddedCommands`: boolean toggle

#### Worktree Tab

- enable/disable `worktree`
- `worktree.worktree-path`: text input
- `worktree.branch`: text input
- `worktree.cleanup`: select input with `always` / `if-clean` / `never`
- `worktree.clone-files`: editable string list

### Phase 2 Editable Fields

Add list/object editing after the basic editor model is stable:

#### Tools & Plugins Tab

- `tools.include`: editable string list
- `tools.exclude`: editable string list
- `plugins`: editable plugin list
- plugin `name`, `path`, and JSON-like `options`

#### Memory Tab

- `memory`: editable ordered string list
- add/remove/reorder memory layer entries

## Component Architecture

Keep `config.tsx` small by extracting focused components and helpers.

### New Files

```text
packages/cli/src/commands/builtins/config/
  config-editor.tsx
  config-state.ts
  config-fields.tsx
  config-panels.tsx
  config-save.ts
  config-serialization.ts
  config-validation.ts
  config-types.ts
```

### Responsibilities

#### `config-editor.tsx`

Top-level TUI container.

- Owns selected tab
- Owns focused field
- Handles global keybindings
- Shows status bar
- Shows save/discard confirmations

#### `config-state.ts`

State reducer for editor operations.

- Update field value
- Track dirty fields
- Reset one field
- Reset all fields
- Track validation errors
- Track editor mode

#### `config-fields.tsx`

Reusable field controls.

- Text field
- Masked text field
- Number field
- Boolean toggle
- Select field
- String list field
- Multiline field

#### `config-panels.tsx`

Panel components for each tab.

- Model panel
- Tools panel
- Memory panel
- Runtime panel
- Worktree panel

Panels should describe editable fields declaratively and delegate field rendering to shared field components.

#### `config-save.ts`

Save orchestration.

- Validate current config
- Serialize TypeScript config
- Write file safely
- Return success or validation/write errors

#### `config-serialization.ts`

Convert `AgentConfig` into `noetic.config.ts` source.

The output should preserve a simple, readable format:

```typescript
import type { AgentConfig } from './packages/cli/src/types/config.js';

export default {
  model: 'anthropic/claude-sonnet-4',
  cwd: process.cwd(),
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  maxTurns: 50,
} satisfies AgentConfig;
```

Do not attempt full AST-preserving edits in the first pass. Prefer deterministic serialization with a confirmation that saving rewrites the config file formatting.

#### `config-validation.ts`

Validation helpers.

- Use `AgentConfigSchema.safeParse`
- Add field-level validation for better messages
- Keep schema validation as the final authority before save

## Data Model

Use explicit field paths rather than ad-hoc state updates.

```typescript
type ConfigFieldPath =
  | 'model'
  | 'apiKey'
  | 'maxTurns'
  | 'systemPrompt'
  | 'systemPromptMode'
  | 'cwd'
  | 'trustProjectEmbeddedCommands'
  | 'worktree.enabled'
  | 'worktree.worktree-path'
  | 'worktree.branch'
  | 'worktree.cleanup'
  | 'worktree.clone-files'
  | 'tools.include'
  | 'tools.exclude'
  | 'plugins'
  | 'memory';
```

Editor state:

```typescript
interface ConfigEditorState {
  originalConfig: AgentConfig;
  draftConfig: AgentConfig;
  sourcePath?: string;
  selectedTab: ConfigTab;
  focusedField?: ConfigFieldPath;
  mode: ConfigEditorMode;
  dirtyFields: ReadonlySet<ConfigFieldPath>;
  validationErrors: ReadonlyMap<ConfigFieldPath, string>;
  globalError?: string;
}
```

Use early returns in reducer helpers and avoid large switch statements by using field handler registries.

## Save Behavior

### Existing Config File

Saving should:

1. Validate `draftConfig` with field-level checks
2. Validate the full object with `AgentConfigSchema.safeParse`
3. Serialize the config to TypeScript
4. Write to the existing `sourcePath`
5. Reload or update in-memory command context if needed
6. Mark state as clean

### New Config File

If no config file exists:

1. Show `No config file found`
2. Offer `Create ./noetic.config.ts`
3. Use the current runtime config as the initial draft
4. Save only after explicit confirmation

### Failed Save

If validation or file write fails:

- Keep the editor open
- Keep all draft changes
- Show field errors where possible
- Show global save error in the status area

## Serialization Scope

The first editable version should rewrite the config file instead of preserving formatting or comments.

Before overwriting an existing file, show a one-time warning:

```text
Saving will rewrite noetic.config.ts using Noetic's standard format. Continue?
```

Future AST-preserving edits can be added later if needed.

## Validation Rules

Field-level validation:

- `model`: non-empty string
- `apiKey`: non-empty string, masked in display
- `maxTurns`: positive integer
- `cwd`: non-empty path string
- `systemPromptMode`: `compose` or `replace`
- `trustProjectEmbeddedCommands`: boolean
- `worktree.cleanup`: `always`, `if-clean`, or `never`
- string lists: no empty entries after trimming

Full validation:

- `AgentConfigSchema.safeParse(draftConfig)` before save

## Implementation Phases

### Phase 1: Editable Core

1. Extract current viewer into config-specific modules
2. Add editor state reducer
3. Add field focus navigation
4. Add text, number, boolean, select, and multiline controls
5. Make Model, Runtime, and basic Worktree fields editable
6. Add dirty-state status bar

### Phase 2: Save Support

1. Thread `sourcePath` into `/config`
2. Add deterministic config serialization
3. Add validated save flow
4. Add unsaved-change confirmation
5. Add no-config-file creation flow

### Phase 3: Collection Editors

1. Add editable string list control
2. Support `tools.include` and `tools.exclude`
3. Support `memory` list editing and reordering
4. Support `worktree.clone-files`

### Phase 4: Plugin Editing

1. Add plugin list editor
2. Support plugin add/remove
3. Support plugin `name` and `path`
4. Support plugin `options` as validated JSON text

### Phase 5: Polish

1. Add contextual help panel
2. Improve validation copy
3. Add save success feedback
4. Add keyboard shortcut tests where practical
5. Run local CI for the CLI workflow

## Tests

Add tests in `packages/cli/test/` for plain helpers:

- Field update reducer behavior
- Dirty field tracking
- Reset field behavior
- Config validation messages
- Config serialization output
- Save flow success using a temp config file
- Save flow validation failure
- New config file creation path

For TUI behavior, keep tests focused on extracted state and serialization helpers. Use `pilotty` manually for end-to-end interaction checks when needed.

## Acceptance Criteria

- `/config` opens the editable TUI
- Existing read-only values still render correctly
- User can edit Model, Runtime, and basic Worktree fields
- Invalid fields are shown before save
- Save writes a valid `noetic.config.ts`
- Unsaved changes cannot be lost silently
- No config file case is handled explicitly
- Existing tab navigation still works
- `bun run typecheck`, `bunx biome check .`, and relevant `bun test` suites pass

## Future Considerations

- AST-preserving saves that retain comments and formatting
- Model picker backed by OpenRouter model metadata
- API key storage in a secure secrets provider instead of config files
- Plugin marketplace browsing
- Config profiles
- Import/export config presets
- Config history and revert support
