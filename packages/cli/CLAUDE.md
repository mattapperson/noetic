# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

`@noetic/cli` is the interactive coding agent CLI/TUI for the Noetic framework. It provides an Ink-based terminal UI for conversational coding with LLM-powered tools.

## Commands

```bash
# Run the CLI in development mode
bun run dev

# Run tests (unit tests only)
bun test

# Run e2e TUI tests with tui-test
bun run test:e2e

# Run live e2e tests (requires OPENROUTER_API_KEY)
bun run test:e2e:live

# Type checking and linting
bun run typecheck
bun run lint
bun run lint:fix
```

## Testing the TUI with pilotty

Use `pilotty` for TUI automation when manually testing or debugging the CLI:

```bash
# Spawn the CLI TUI with a named session
pilotty spawn --name noetic bash -c "bun run src/cli/cli.ts"

# Wait for the TUI to be ready
pilotty wait-for -s noetic "Type a message..." --timeout 5000

# Get current screen state
pilotty snapshot -s noetic

# Type text into the prompt
pilotty type -s noetic "hello world"

# Press keys (Enter to submit, Escape to stop streaming)
pilotty key -s noetic Enter
pilotty key -s noetic Escape

# Always re-snapshot after screen changes
pilotty snapshot -s noetic

# Clean up when done
pilotty kill -s noetic
```

## Architecture

### Entry Flow

1. `src/cli/cli.ts` - CLI entry point, parses args, discovers config, loads plugins
2. `src/config/discovery.ts` - Searches for `noetic.config.ts` in cwd, `.noetic/`, or `~/.config/noetic/`
3. `src/plugins/loader.ts` - Loads and validates plugins from config
4. `src/harness/factory.ts` - Creates `AgentHarness` with tools and memory layers
5. `src/tui/app.tsx` - Root Ink app, manages conversation state and streaming

### TUI Components (`src/tui/`)

- `app.tsx` - Main app component, orchestrates harness execution and state
- `components/responses-chat.tsx` - Chat display with message/tool output rendering
- `components/prompt-input.tsx` - Input component with autocomplete, history, and status
- `item-utils.ts` - Converts between Open Responses `Item` types and UI entries

### Tool System (`src/tools/`)

Tools are created with a `cwd` context and return `Tool` type from `@noetic/core`:

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `write` | Create/overwrite files |
| `edit` | Apply diff-based edits |
| `bash` | Execute shell commands (with security validation) |
| `grep` | Search file contents |
| `find` | Find files by pattern |
| `ls` | List directory contents |
| `agent` | Spawn a sub-agent (teammate) sync, background, or named+addressable; optional `isolation: 'worktree'`. Picks skill by `subagent_type`. |
| `sendMessage` | Write a message to a named teammate's inbound queue; the teammate sees it as `<inbound-message>` on its next turn. |
| `checkAgent` | Poll status/result/error of a previously-launched teammate by agentId. |

Use `createCodingTools(cwd, fs?)` for full toolset or `createReadOnlyTools(cwd, fs?)` for safe exploration. Both accept an optional `FsAdapter` from `@noetic/core` (defaults to local filesystem).

Teammate tools compose `@noetic/core` primitives (`spawn`, `react`, `detachedSpawn`, memory layers) via the per-harness `TeammateRegistry` in `src/agents/registry-runtime.ts`. Background/named teammates run on a fresh `threadId` (passed via `detachedSpawn` overrides) so they do not pollute the parent's session item log.

### Plugin System

Plugins extend the CLI with custom tools and memory layers:

```typescript
interface NoeticPlugin {
  name: string;
  version: string;
  tools?: () => ReadonlyArray<Tool> | Promise<ReadonlyArray<Tool>>;
  memoryLayers?: () => ReadonlyArray<MemoryLayer> | Promise<ReadonlyArray<MemoryLayer>>;
  initialize?: (config: AgentConfig) => Promise<void>;
  dispose?: () => Promise<void>;
}
```

Plugins are loaded from paths specified in `noetic.config.ts` and initialized in order, disposed in reverse order.

### Configuration

Config is loaded from (in order of precedence):
1. `./noetic.config.ts`
2. `./.noetic/config.ts`
3. `~/.config/noetic/config.ts`
4. `~/.noetic/config.ts`

If no config file found, CLI args are used with defaults:
- Model: `anthropic/claude-sonnet-4`
- API: OpenRouter (requires `OPENROUTER_API_KEY`)
- Max turns: 50

## E2E Test Pattern

Tests use `@microsoft/tui-test` with helpers in `test/e2e/helpers.ts`:

```typescript
import { Shell, test } from '@microsoft/tui-test';
import { waitForView, typeSlowly } from './helpers.js';

test.use({
  shell: Shell.Bash,
  program: { file: 'bun', args: ['run', cliPath, '--api-key', 'test-key'] },
});

test('shows prompt', async ({ terminal }) => {
  await waitForView(terminal, 'Type a message...');
});
```
