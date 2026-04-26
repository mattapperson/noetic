# Config UI/Command - Tab-Based Interface Plan

## Overview

Create a tab-based configuration interface for the `/config` command in the noetic CLI, inspired by droid's `/settings` command. This will provide an intuitive way to view and modify agent configuration settings through a structured TUI.

## Current State Analysis

From examining the codebase:
- Configuration is defined in `packages/cli/src/types/config.ts` with `AgentConfigSchema`
- Current commands exist in `packages/cli/src/commands/builtins/`
- Configuration discovery exists in `packages/cli/src/config/discovery.ts`
- No existing `/config` command - needs to be built from scratch

## Key Configuration Areas

Based on `AgentConfigSchema`, the main configuration areas are:

1. **Model Settings**
   - Model selection
   - API key management
   - Max turns
   - System prompt configuration

2. **Tools & Plugins**
   - Plugin management (install/remove/configure)
   - Tool inclusion/exclusion
   - Plugin options

3. **Memory Layers**
   - Memory layer selection and configuration
   - Custom layer settings

4. **Runtime Settings**
   - Working directory
   - Trust settings for project commands
   - System prompt mode (replace vs compose)

5. **Worktree Configuration**
   - Isolation settings
   - Hook configuration
   - Cleanup policies

## UI Design (Tab-Based Structure)

### Tab Layout
```
┌─ Model ─┬─ Tools & Plugins ─┬─ Memory ─┬─ Runtime ─┬─ Worktree ─┐
│         │                   │          │           │            │
│ Content │                   │          │           │            │ 
│   Area  │                   │          │           │            │
│         │                   │          │           │            │
└─────────┴───────────────────┴──────────┴───────────┴────────────┘
```

### Tab 1: Model Settings
- **Model Selection**: Dropdown/autocomplete for available models
- **API Key**: Secure text input with masking
- **Max Turns**: Numeric input with validation
- **System Prompt**: Text area with preview
- **System Prompt Mode**: Radio buttons (compose/replace)

### Tab 2: Tools & Plugins
- **Installed Plugins**: List with enable/disable toggles
- **Available Plugins**: Browse and install new plugins
- **Plugin Configuration**: Per-plugin options editing
- **Tool Management**: Include/exclude specific tools
- **Plugin Status**: Health checks and version info

### Tab 3: Memory Layers
- **Active Layers**: Ordered list with drag-to-reorder
- **Available Layers**: Browse built-in and custom layers
- **Layer Configuration**: Per-layer settings
- **Memory Stats**: Usage and performance metrics

### Tab 4: Runtime Settings
- **Working Directory**: Path selector with validation
- **Trust Settings**: Checkbox for project command execution
- **Session Persistence**: Toggle and cleanup options
- **Performance**: Timeout and resource limits

### Tab 5: Worktree Configuration
- **Isolation Mode**: Enable/disable worktree isolation
- **Path Templates**: Configure worktree path patterns
- **Hook Configuration**: Pre/post hooks for worktree lifecycle
- **Cleanup Policy**: When to clean up worktrees

## Technical Implementation

### Command Structure
```typescript
// packages/cli/src/commands/builtins/config.tsx
export const configCommand: NoeticCommand = {
  name: 'config',
  description: 'Configure agent settings',
  handler: async (ctx) => {
    const configUI = new ConfigUI(ctx.config);
    return configUI.render();
  }
};
```

### Component Architecture
```typescript
interface ConfigUIState {
  activeTab: ConfigTab;
  config: AgentConfig;
  isDirty: boolean;
  validationErrors: Record<string, string>;
}

enum ConfigTab {
  Model = 'model',
  ToolsPlugins = 'tools',
  Memory = 'memory', 
  Runtime = 'runtime',
  Worktree = 'worktree'
}
```

### Key Components

1. **ConfigTabs**: Main container with tab navigation
2. **ModelConfigPanel**: Model and API key settings
3. **PluginsPanel**: Plugin management interface
4. **MemoryPanel**: Memory layer configuration
5. **RuntimePanel**: Runtime behavior settings
6. **WorktreePanel**: Worktree isolation configuration

### Navigation & Interaction

- **Tab Switching**: Left/Right arrow keys, Tab key, or mouse clicks
- **Form Validation**: Real-time validation with error indicators
- **Save/Cancel**: Explicit save required, with unsaved changes warning
- **Help Text**: Context-sensitive help for each setting
- **Reset**: Reset to defaults per tab or globally

### Data Flow

1. **Load**: Read current config from discovery system
2. **Edit**: Modify settings in-memory with validation
3. **Preview**: Show impact of changes before saving
4. **Save**: Write changes back to config file
5. **Apply**: Restart necessary services if needed

## Implementation Steps

### Phase 1: Core Infrastructure
1. Create basic `/config` command handler
2. Implement tab navigation component
3. Set up config state management
4. Create validation framework

### Phase 2: Individual Tabs
1. Model configuration tab (most critical)
2. Runtime settings tab
3. Tools & plugins tab
4. Memory configuration tab
5. Worktree configuration tab

### Phase 3: Polish & Features
1. Add help system and tooltips
2. Implement config validation
3. Add import/export functionality
4. Create config templates/presets

### Phase 4: Advanced Features
1. Plugin marketplace integration
2. Configuration sharing
3. Advanced validation and recommendations
4. Configuration migration tools

## Files to Create/Modify

### New Files
- `packages/cli/src/commands/builtins/config.tsx` - Main command
- `packages/cli/src/commands/builtins/config/` - Component directory
  - `config-tabs.tsx` - Tab container
  - `model-panel.tsx` - Model configuration
  - `plugins-panel.tsx` - Plugin management
  - `memory-panel.tsx` - Memory layers
  - `runtime-panel.tsx` - Runtime settings
  - `worktree-panel.tsx` - Worktree configuration
  - `config-types.ts` - UI-specific types

### Modified Files
- `packages/cli/src/commands/builtins/index.ts` - Register new command
- `packages/cli/src/types/config.ts` - Add UI state types if needed

## Success Metrics

1. **Usability**: Users can easily navigate and modify settings
2. **Completeness**: All `AgentConfig` fields are configurable
3. **Validation**: Clear error messages for invalid configurations
4. **Performance**: Responsive UI with minimal lag
5. **Consistency**: Matches droid's UX patterns and conventions

## Future Enhancements

1. **Configuration Profiles**: Multiple named configurations
2. **Team Sharing**: Export/import configurations
3. **Advanced Validation**: Dependency checking between settings
4. **Plugin Marketplace**: Browse and install plugins from registry
5. **Configuration History**: Track and revert configuration changes