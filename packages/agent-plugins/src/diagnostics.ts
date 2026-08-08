/**
 * Agent Plugins §11.3 — "Clients SHOULD report invalid configuration and
 * component failures."
 *
 * Every place the spec says *skip* or *ignore*, this client also records why.
 * Silent skipping is the failure mode the spec's diagnostic requirement exists
 * to prevent: a plugin author whose skill quietly never loads has no way to
 * find out. Diagnostics are surfaced on the context layer (`ctx.context
 * ['agent-plugins'].diagnostics`) and mirrored onto the execution trace.
 */

//#region Codes

/** @public Why a plugin, component type, or component entry was rejected or skipped. */
export const DiagnosticCode = {
  /** §4.1(1) / §5.3 / §5.5 — the plugin itself is unusable. Nothing is loaded from it. */
  PluginRejected: 'plugin-rejected',
  /** §5.2 — an unknown top-level manifest field. Reported and ignored; loading continues. */
  UnknownManifestField: 'unknown-manifest-field',
  /** §8.1 — `extensions` was present but not an object. Reported and ignored. */
  InvalidExtensions: 'invalid-extensions',
  /** §6.2 — a fixed component location exists but is the wrong filesystem kind. */
  ComponentTypeInvalid: 'component-type-invalid',
  /** §7.1 — a discovered skill does not conform to the Agent Skills spec. */
  SkillSkipped: 'skill-skipped',
  /**
   * A skill loaded, but something about it is worth reporting — most often a
   * frontmatter key the Agent Skills specification does not define, which is
   * legal but is also what a typo looks like.
   */
  SkillWarning: 'skill-warning',
  /** §7.2.2(2) — `mcp.json` is unusable, so MCP is disabled for this plugin. */
  McpDisabled: 'mcp-disabled',
  /** §7.2.2(3) — one server entry is invalid. Siblings still load. */
  McpServerInvalid: 'mcp-server-invalid',
  /** §7.2.2(4) — the client does not implement this entry's declared transport. */
  McpTransportUnsupported: 'mcp-transport-unsupported',
  /** §7.2.2(5) — the server was valid but failed to start, connect, or handshake. */
  McpConnectFailed: 'mcp-connect-failed',
  /**
   * A configured scan root could not be read. Not a spec rule — a
   * configuration mistake, and the single most likely one, so it is reported
   * rather than silently yielding zero plugins.
   */
  RootUnreadable: 'root-unreadable',
  /** A configured scan root was readable but held no plugin directories. */
  RootEmpty: 'root-empty',
} as const;

/** @public */
export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

//#endregion

//#region Diagnostic

/** @public One reportable problem encountered while loading a plugin. */
export interface PluginDiagnostic {
  code: DiagnosticCode;
  /** Directory the plugin was loaded from. Present even when the plugin was rejected. */
  pluginDir: string;
  /** Manifest `name`, when the manifest parsed far enough to have one. */
  pluginName?: string;
  /** The skill directory or MCP server key the problem belongs to, when scoped to one. */
  component?: string;
  /** Human-readable explanation. Always mentions the spec section it enforces. */
  detail: string;
}

/**
 * Build a diagnostic. A thin helper rather than an inline object literal so the
 * optional fields stay off the object when unset — a `component: undefined` key
 * would show up in `JSON.stringify` output the model reads.
 *
 * @public
 */
export function diagnostic(params: {
  code: DiagnosticCode;
  pluginDir: string;
  detail: string;
  pluginName?: string;
  component?: string;
}): PluginDiagnostic {
  return {
    code: params.code,
    pluginDir: params.pluginDir,
    detail: params.detail,
    ...(params.pluginName === undefined
      ? {}
      : {
          pluginName: params.pluginName,
        }),
    ...(params.component === undefined
      ? {}
      : {
          component: params.component,
        }),
  };
}

//#endregion
