/**
 * Returns the configured context layers, preferring the current `context` key
 * and falling back to the pre-rename `memory` key.
 *
 * `context` wins when both are set — an explicit new-style key should never be
 * silently overridden by a stale one left behind mid-migration.
 *
 * This is the only place in core that *resolves* `.memory`. Every public entry
 * point that used to take `memory` — `provide`, `spawn`, `tool`, `react`, the
 * `AgentHarness` constructor, `createContext`, `execute`, `restore` — declares
 * the deprecated key alongside its `context` replacement and resolves it
 * through here.
 *
 * Removing the alias at the next major means deleting the `memory?`
 * declarations, this function, and the one place that destructures the key off
 * an options bag before forwarding it (`AgentHarness.createContext`).
 *
 * @internal
 */
export function resolveContextOption<T>(opts: { context?: T; memory?: T }): T | undefined {
  return opts.context ?? opts.memory;
}
