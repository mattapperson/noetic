# Hot Reload: AGENT.md, Rules, and Skills

## Problem

AGENT.md, `.agent/rules/*.md`, and skill definitions (`.claude/skills/`, `.agent/skills/`, `.noetic/skills/`) are loaded once at harness construction time. The `agentMdLayer` and `skillsLayer` both use `scope: 'execution'`, so their `init()` result is cached for the entire CLI session. Changes to these files require restarting the agent to take effect — a friction point during iterative rule/skill authoring.

## Goal

Detect filesystem changes to instruction and skill files and refresh the corresponding memory layer state automatically, without restarting the CLI session. The next agent turn uses the updated content.

## Design

### Architecture

```
File Watcher (fs.watch) ──▶ HotReloadService ──▶ harness.setLayerState()
                              (debounced)           (mutates layer state)
```

`AgentHarness` already exposes `getLayerState` / `setLayerState` (used by the layer lifecycle system). The CLI can mutate layer state directly between turns. The next `recall()` naturally picks up the refreshed state.

### Watched Paths

| Category | Paths |
|----------|-------|
| AGENT.md + rules | `./AGENT.md`, `./.agent/AGENT.md`, `./.agent/rules/*.md` |
| Skills | `./.noetic/skills/`, `./.agent/skills/`, `./.claude/skills/` |

User-global paths (`~/.config/noetic/`, `~/.noetic/`) are **not** watched by default — they change rarely and are shared across sessions. Can be opted in later.

### Debounce

300ms trailing debounce per watched path. Rapid saves (e.g. format-on-save + manual save) coalesce into a single reload.

### Activation

Opt-in via `AgentConfig.hotReload: true` (default `false`). When enabled, `createAgentHarness` instantiates and starts a `HotReloadService` alongside the harness.

### Notification

When a reload succeeds, emit a framework event (`agent_instructions_reloaded` or `skills_reloaded`) via the harness's event broadcaster so the TUI can show an indicator.

## Changes

### New Files

- `packages/cli/src/hot-reload/service.ts` — `HotReloadService` class
- `packages/cli/src/hot-reload/watcher.ts` — thin `fs.watch` wrapper with debounce
- `packages/cli/src/hot-reload/index.ts` — public exports
- `packages/cli/test/hot-reload.test.ts` — unit tests

### Modified Files

- `packages/cli/src/types/config.ts` — add `hotReload?: boolean` to `AgentConfig`
- `packages/cli/src/harness/factory.ts` — start `HotReloadService` when `config.hotReload === true`
- `packages/cli/src/config/agent-md-loader.ts` — export `getWatchedPaths(cwd)` helper
- `packages/cli/src/skills/discovery.ts` — export `getWatchedSkillDirs(cwd)` helper
- `packages/cli/src/index.ts` — re-export hot-reload types
- `specs/12a-cli-memory-layers.md` — document hot-reload behavior

## No Core Changes Required

The feature is purely in `@noetic/cli`. The harness's existing `setLayerState` API is sufficient. No changes to `@noetic/core` memory layer contracts, hooks, or lifecycle.

## Test Strategy

1. **Unit**: Mock `fs.watch` to simulate file changes; assert `setLayerState` is called with updated content.
2. **Integration**: Create temp files → start service → mutate files → assert layer state reflects changes.
3. **Debounce**: Fire two rapid changes → assert loader runs exactly once.
4. **Cleanup**: Stop service → assert watchers are closed.

## Out of Scope (Future)

- Watching user-global paths (`~/.config/noetic/`, `~/.noetic/`)
- Pushing a `<system-reminder>` to the model mid-turn (only refreshes on next `recall`)
- Watchman/chokidar integration (keep zero new dependencies; use `node:fs`)
