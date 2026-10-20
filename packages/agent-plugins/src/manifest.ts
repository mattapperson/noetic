/**
 * Agent Plugins §5 — the `plugin.json` manifest, and §8 — client extensions.
 *
 * The manifest schema is *closed*, but "closed" here does not mean "reject
 * anything unexpected". §5.2 carves out two non-fatal exceptions that a naive
 * `z.strictObject().parse()` would get wrong:
 *
 *   - an unknown top-level field is reported and **ignored**, and the plugin
 *     still loads;
 *   - a non-object `extensions` field is reported and **ignored** (§8.1).
 *
 * Every other violation is fatal to the whole plugin. That split is why
 * validation is hand-rolled around a Zod schema for the known fields rather
 * than delegated wholesale to Zod's strict mode.
 */

import { z } from 'zod';
import type { PluginDiagnostic } from './diagnostics';
import { DiagnosticCode, diagnostic } from './diagnostics';

//#region Constants

/** @public The Agent Plugins spec version this client implements. */
export const SPEC_VERSION = '1.0.0';

/** @public Canonical `$schema` identifier for `plugin.json` at {@link SPEC_VERSION} (§5.2). */
export const PLUGIN_SCHEMA_ID = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;

/**
 * @public The reverse-domain extension namespace Noetic claims under §8.
 *
 * Noetic's semantics are deliberately pass-through: the manifest data under
 * this key and the contents of the matching `tools.noetic/` directory are
 * surfaced verbatim to the host. Fixing a format now would lock in a contract
 * before anything consumes it.
 */
export const NOETIC_EXTENSION_NAMESPACE = 'tools.noetic';

/**
 * §5.2 lists the only permitted top-level fields. Anything else is an unknown
 * field: reported, ignored, non-fatal.
 */
const KNOWN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

/** §5.5 — 1-64 chars, `[a-z0-9.-]`, alphanumeric at both ends, no `--` or `..`. */
const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

//#endregion

//#region Schema

/** @public §5.4 — the author object permits only `name`, `email`, and `url`, all strings. */
export const AuthorSchema = z.strictObject({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

/**
 * @public The known-field shape of `plugin.json`.
 *
 * `extensions` is typed loosely here on purpose. §8.1 makes a non-object value
 * non-fatal, so it is stripped before this schema runs rather than being
 * allowed to fail the whole parse.
 */
export const PluginManifestSchema = z.object({
  $schema: z.literal(PLUGIN_SCHEMA_ID),
  name: z.string().min(1).max(64).regex(NAME_PATTERN),
  version: z.string().optional(),
  description: z.string().optional(),
  author: AuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/** @public A validated `plugin.json`. */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

//#endregion

//#region Validation

/** @public Result of validating a `plugin.json` document. */
export type ManifestResult =
  | {
      ok: true;
      manifest: PluginManifest;
      /** Non-fatal problems (§5.2 unknown fields, §8.1 bad `extensions`). */
      diagnostics: PluginDiagnostic[];
    }
  | {
      ok: false;
      /** The fatal problem. The plugin is rejected and nothing is loaded from it. */
      diagnostics: PluginDiagnostic[];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when every member value of an `extensions` object is itself an object.
 *
 * §8.1 requires namespace values to be objects, and §5.2 makes that a fatal
 * schema violation (only a non-object `extensions` *itself* is the non-fatal
 * carve-out). Checked before the Zod parse so the fatal path reports the real
 * cause instead of a generic record-type failure.
 */
function hasNonObjectNamespace(extensions: Record<string, unknown>): string | null {
  for (const [namespace, value] of Object.entries(extensions)) {
    if (!isPlainObject(value)) {
      return namespace;
    }
  }
  return null;
}

function reject(pluginDir: string, code: DiagnosticCode, detail: string): ManifestResult {
  return {
    ok: false,
    diagnostics: [
      diagnostic({
        code,
        pluginDir,
        detail,
      }),
    ],
  };
}

/**
 * Validate a parsed `plugin.json` document against §5.
 *
 * @public
 * @param raw - The parsed JSON value. Callers handle the read/parse failure.
 * @param pluginDir - Directory the manifest came from, for diagnostics.
 */
export function validateManifest(raw: unknown, pluginDir: string): ManifestResult {
  if (!isPlainObject(raw)) {
    return reject(
      pluginDir,
      DiagnosticCode.PluginRejected,
      '§5.2: plugin.json must contain a top-level JSON object',
    );
  }

  const diagnostics: PluginDiagnostic[] = [];
  const known: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(field)) {
      // §5.2: report and ignore. The plugin still loads.
      diagnostics.push(
        diagnostic({
          code: DiagnosticCode.UnknownManifestField,
          pluginDir,
          detail: `§5.2: unknown top-level field '${field}' ignored; client-specific data belongs under 'extensions'`,
        }),
      );
      continue;
    }
    known[field] = value;
  }

  if ('extensions' in known && !isPlainObject(known.extensions)) {
    // §8.1: a non-object `extensions` is reported and ignored, not fatal.
    diagnostics.push(
      diagnostic({
        code: DiagnosticCode.InvalidExtensions,
        pluginDir,
        detail: '§8.1: `extensions` must be an object; field ignored',
      }),
    );
    delete known.extensions;
  }

  if (isPlainObject(known.extensions)) {
    const badNamespace = hasNonObjectNamespace(known.extensions);
    if (badNamespace !== null) {
      return reject(
        pluginDir,
        DiagnosticCode.PluginRejected,
        `§8.1: extensions['${badNamespace}'] must be an object`,
      );
    }
  }

  // §5.2: the `$schema` gate selects local validation rules and is never
  // fetched over the network. An unsupported version rejects the plugin.
  if (known.$schema !== undefined && known.$schema !== PLUGIN_SCHEMA_ID) {
    return reject(
      pluginDir,
      DiagnosticCode.PluginRejected,
      `§5.2: unsupported Agent Plugins version — $schema is '${String(known.$schema)}', this client implements '${PLUGIN_SCHEMA_ID}'`,
    );
  }

  const parsed = PluginManifestSchema.safeParse(known);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || '<root>';
    return reject(
      pluginDir,
      DiagnosticCode.PluginRejected,
      `§5.3/§5.5: invalid manifest field '${field}': ${issue?.message ?? 'schema violation'}`,
    );
  }

  return {
    ok: true,
    manifest: parsed.data,
    diagnostics,
  };
}

//#endregion

//#region Extensions

/**
 * Read the manifest data for a client extension namespace (§8.1).
 *
 * Returns `undefined` when the namespace is absent. Contents are never
 * validated — §8 leaves them entirely to the owning client, and §11.1(3)
 * requires unimplemented namespaces be ignored *without* validating them.
 *
 * @public
 */
export function readExtension(
  manifest: PluginManifest,
  namespace: string,
): Record<string, unknown> | undefined {
  return manifest.extensions?.[namespace];
}

//#endregion
