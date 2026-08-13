/**
 * Provider APIs (Anthropic via OpenRouter) enforce tool names match
 * `^[a-zA-Z0-9_-]{1,64}$`. Noetic's internal layer-tool names use `layerId/fn`
 * which contains a forbidden `/`. We translate to a wire-safe form only at
 * the SDK boundary; internal tool-name identity (and every codebase reference
 * to names like `plan/updatePrd`) is preserved.
 * @internal
 */
export function sanitizeToolNameForWire(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
