/**
 * Agent Plugins §6 — component discovery — and the §11.3 resilience rules that
 * govern what happens when part of a plugin is broken.
 *
 * The organizing principle is the failure-boundary ladder of §4.1: a problem
 * is handled at the *narrowest* scope that contains it. A malformed manifest
 * rejects the plugin; a `skills` path that is a regular file invalidates only
 * the skills component type; one non-conforming `SKILL.md` skips only that
 * skill. Nothing here ever aborts a scan because one plugin was bad.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginDiagnostic } from './diagnostics';
import { DiagnosticCode, diagnostic } from './diagnostics';
import type { PluginManifest } from './manifest';
import { NOETIC_EXTENSION_NAMESPACE, SPEC_VERSION, validateManifest } from './manifest';
import type { McpServerConfig } from './mcp-config';
import { parseMcpDocument, validateMcpEntry } from './mcp-config';
import { containedPath, resolveRoot } from './paths';
import type { SkillFrontmatter } from './skill';
import { parseSkill } from './skill';

//#region Types

/** @public One skill discovered inside a plugin (§7.1). */
export interface DiscoveredSkill {
  /** The skill directory name, which the Agent Skills spec requires to equal `frontmatter.name`. */
  id: string;
  /** Qualified as `<plugin>/<skill>` — unique across every loaded plugin. */
  qualifiedId: string;
  pluginName: string;
  /** Absolute path to the skill directory. */
  directory: string;
  frontmatter: SkillFrontmatter;
  /** The Markdown body: the skill's instructions, loaded on activation. */
  body: string;
}

/** @public A server entry that passed validation, paired with the key it was declared under. */
export interface DiscoveredMcpServer {
  key: string;
  /** Qualified as `<plugin>/<key>` — server keys are only unique within a plugin. */
  qualifiedKey: string;
  pluginName: string;
  config: McpServerConfig;
}

/** @public A plugin that loaded successfully, with whatever components were valid. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Filesystem-resolved plugin root (§4.1). */
  root: string;
  /** Per-plugin persistent data directory (§9.1 `PLUGIN_DATA`). */
  dataDir: string;
  skills: DiscoveredSkill[];
  mcpServers: DiscoveredMcpServer[];
  /** Manifest data under `extensions['tools.noetic']`, verbatim (§8.1). */
  noeticExtension?: Record<string, unknown>;
  /** Absolute path to the `tools.noetic/` directory, when it exists (§8.2). */
  noeticExtensionDir?: string;
}

/** @public Everything a scan produced: the plugins that loaded, and why anything did not. */
export interface DiscoveryResult {
  plugins: LoadedPlugin[];
  diagnostics: PluginDiagnostic[];
}

//#endregion

//#region Filesystem helpers

const FileKind = {
  File: 'file',
  Directory: 'directory',
  Other: 'other',
  Missing: 'missing',
} as const;

type FileKind = (typeof FileKind)[keyof typeof FileKind];

/**
 * Classify a path. §6.2 needs three outcomes kept apart: absent (not an
 * error), present as the expected kind, and present as the wrong kind (the
 * component type is invalid).
 *
 * `stat` follows symlinks, which is what the spec wants — §4.1 permits a
 * symlink whose target is inside the root, and containment is enforced
 * separately by `containedPath`.
 */
async function classify(path: string): Promise<FileKind> {
  try {
    const stats = await stat(path);
    if (stats.isDirectory()) {
      return FileKind.Directory;
    }
    if (stats.isFile()) {
      return FileKind.File;
    }
    return FileKind.Other;
  } catch {
    return FileKind.Missing;
  }
}

async function readJson(path: string): Promise<
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      detail: string;
    }
> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(text),
    };
  } catch (error) {
    return {
      ok: false,
      detail: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

//#endregion

//#region Skills

/**
 * Discover skills from the fixed `skills/` location (§7.1).
 *
 * Only immediate children are considered, and each must contain a path named
 * exactly `SKILL.md` that resolves to a regular file. Everything that fails is
 * reported and skipped; the caller keeps loading other component types.
 */
async function discoverSkills(params: {
  pluginRoot: string;
  pluginName: string;
  diagnostics: PluginDiagnostic[];
}): Promise<DiscoveredSkill[]> {
  const { pluginRoot, pluginName, diagnostics } = params;
  const skillsDir = join(pluginRoot, 'skills');

  const kind = await classify(skillsDir);
  if (kind === FileKind.Missing) {
    // §6.2: an absent fixed location is not an error.
    return [];
  }
  if (kind !== FileKind.Directory) {
    diagnostics.push(
      diagnostic({
        code: DiagnosticCode.ComponentTypeInvalid,
        pluginDir: pluginRoot,
        pluginName,
        detail: '§6.2: `skills` exists but is not a directory; skills are unavailable',
      }),
    );
    return [];
  }

  const contained = await containedPath(pluginRoot, skillsDir);
  if (!contained.ok) {
    // §4.1 rule 2: a fixed component location outside the root invalidates
    // that component type rather than the whole plugin.
    diagnostics.push(
      diagnostic({
        code: DiagnosticCode.ComponentTypeInvalid,
        pluginDir: pluginRoot,
        pluginName,
        detail: `§4.1: 'skills' resolves outside the plugin root (${contained.reason})`,
      }),
    );
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(contained.path);
  } catch (error) {
    diagnostics.push(
      diagnostic({
        code: DiagnosticCode.ComponentTypeInvalid,
        pluginDir: pluginRoot,
        pluginName,
        detail: `§6.2: 'skills' could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    return [];
  }

  const skills: DiscoveredSkill[] = [];
  // Sorted so the skill index the model sees is stable across runs — an
  // unstable ordering would churn the prompt-cache prefix for no reason.
  for (const entry of entries.sort()) {
    const skill = await loadSkill({
      skillDir: join(contained.path, entry),
      entry,
      pluginRoot,
      pluginName,
      diagnostics,
    });
    if (skill !== null) {
      skills.push(skill);
    }
  }
  return skills;
}

async function loadSkill(params: {
  skillDir: string;
  entry: string;
  pluginRoot: string;
  pluginName: string;
  diagnostics: PluginDiagnostic[];
}): Promise<DiscoveredSkill | null> {
  const { skillDir, entry, pluginRoot, pluginName, diagnostics } = params;

  const skip = (detail: string): null => {
    diagnostics.push(
      diagnostic({
        code: DiagnosticCode.SkillSkipped,
        pluginDir: pluginRoot,
        pluginName,
        component: entry,
        detail,
      }),
    );
    return null;
  };

  if ((await classify(skillDir)) !== FileKind.Directory) {
    // A stray file directly inside `skills/` is simply not a skill. Silence
    // here would be wrong: an author who put `SKILL.md` at `skills/SKILL.md`
    // needs to hear about it.
    return skip('§7.1: not a directory; only directories containing SKILL.md are skills');
  }

  const manifestPath = join(skillDir, 'SKILL.md');
  if ((await classify(manifestPath)) !== FileKind.File) {
    return skip('§7.1: no SKILL.md regular file; not a skill');
  }

  // §4.1 rule 3: a discovered SKILL.md outside the plugin root is skipped.
  const contained = await containedPath(pluginRoot, manifestPath);
  if (!contained.ok) {
    return skip(`§4.1: SKILL.md resolves outside the plugin root (${contained.reason})`);
  }

  let source: string;
  try {
    source = await readFile(contained.path, 'utf8');
  } catch (error) {
    return skip(
      `§7.1: SKILL.md could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseSkill(source, entry);
  if (!parsed.ok) {
    return skip(`§7.1: ${parsed.detail}`);
  }

  return {
    id: entry,
    qualifiedId: `${pluginName}/${entry}`,
    pluginName,
    directory: skillDir,
    frontmatter: parsed.skill.frontmatter,
    body: parsed.skill.body,
  };
}

//#endregion

//#region MCP servers

/**
 * Discover MCP server entries from the fixed `mcp.json` location (§7.2).
 *
 * A document-level problem disables MCP for this plugin only; an entry-level
 * problem skips that entry only.
 */
async function discoverMcpServers(params: {
  pluginRoot: string;
  pluginName: string;
  diagnostics: PluginDiagnostic[];
}): Promise<DiscoveredMcpServer[]> {
  const { pluginRoot, pluginName, diagnostics } = params;
  const configPath = join(pluginRoot, 'mcp.json');

  const disable = (detail: string): DiscoveredMcpServer[] => {
    diagnostics.push(
      diagnostic({
        code: DiagnosticCode.McpDisabled,
        pluginDir: pluginRoot,
        pluginName,
        detail,
      }),
    );
    return [];
  };

  const kind = await classify(configPath);
  if (kind === FileKind.Missing) {
    // §6.2: an absent fixed location is not an error.
    return [];
  }
  if (kind !== FileKind.File) {
    return disable('§6.2: `mcp.json` exists but is not a regular file; MCP is disabled');
  }

  const contained = await containedPath(pluginRoot, configPath);
  if (!contained.ok) {
    return disable(`§4.1: 'mcp.json' resolves outside the plugin root (${contained.reason})`);
  }

  const json = await readJson(contained.path);
  if (!json.ok) {
    return disable(`§7.2.2: mcp.json ${json.detail}`);
  }

  const document = parseMcpDocument(json.value, SPEC_VERSION);
  if (!document.ok) {
    return disable(document.detail);
  }

  const servers: DiscoveredMcpServer[] = [];
  for (const [key, raw] of Object.entries(document.document.mcpServers).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entry = validateMcpEntry(raw);
    if (!entry.ok) {
      // §7.2.2 rule 3: skip this server, keep the others.
      diagnostics.push(
        diagnostic({
          code: DiagnosticCode.McpServerInvalid,
          pluginDir: pluginRoot,
          pluginName,
          component: key,
          detail: entry.detail,
        }),
      );
      continue;
    }
    servers.push({
      key,
      qualifiedKey: `${pluginName}/${key}`,
      pluginName,
      config: entry.config,
    });
  }
  return servers;
}

//#endregion

//#region Extension directory

/**
 * Locate the `tools.noetic/` extension directory (§8.2), if the plugin ships
 * one. Absence is normal and silent; a directory that escapes the plugin root
 * is denied per §4.1 rule 5.
 */
async function findExtensionDir(pluginRoot: string): Promise<string | undefined> {
  const dir = join(pluginRoot, NOETIC_EXTENSION_NAMESPACE);
  if ((await classify(dir)) !== FileKind.Directory) {
    return undefined;
  }
  const contained = await containedPath(pluginRoot, dir);
  return contained.ok ? contained.path : undefined;
}

//#endregion

//#region Plugin loading

/** @public Outcome of loading a single plugin directory. */
export interface LoadPluginResult {
  plugin: LoadedPlugin | null;
  diagnostics: PluginDiagnostic[];
}

/**
 * Load one plugin directory: validate its manifest, then discover each
 * supported component type independently.
 *
 * @public
 * @param dir - The plugin directory.
 * @param dataRoot - Base directory under which each plugin's `PLUGIN_DATA` lives.
 */
export async function loadPlugin(dir: string, dataRoot: string): Promise<LoadPluginResult> {
  const diagnostics: PluginDiagnostic[] = [];

  const root = await resolveRoot(dir);
  if (root === null) {
    // §4.1 rule 1: no resolvable root means no plugin.
    return {
      plugin: null,
      diagnostics: [
        diagnostic({
          code: DiagnosticCode.PluginRejected,
          pluginDir: dir,
          detail: '§4.1: the plugin directory could not be resolved',
        }),
      ],
    };
  }

  const manifestPath = join(root, 'plugin.json');
  if ((await classify(manifestPath)) !== FileKind.File) {
    return {
      plugin: null,
      diagnostics: [
        diagnostic({
          code: DiagnosticCode.PluginRejected,
          pluginDir: root,
          detail: '§5.1: no plugin.json regular file at the plugin root',
        }),
      ],
    };
  }

  const contained = await containedPath(root, manifestPath);
  if (!contained.ok) {
    return {
      plugin: null,
      diagnostics: [
        diagnostic({
          code: DiagnosticCode.PluginRejected,
          pluginDir: root,
          detail: `§4.1: plugin.json resolves outside the plugin root (${contained.reason})`,
        }),
      ],
    };
  }

  const json = await readJson(contained.path);
  if (!json.ok) {
    return {
      plugin: null,
      diagnostics: [
        diagnostic({
          code: DiagnosticCode.PluginRejected,
          pluginDir: root,
          detail: `§5.2: plugin.json ${json.detail}`,
        }),
      ],
    };
  }

  const validated = validateManifest(json.value, root);
  if (!validated.ok) {
    // §11.3 rule 2: fatal to the plugin — no component is discovered.
    return {
      plugin: null,
      diagnostics: validated.diagnostics,
    };
  }
  diagnostics.push(...validated.diagnostics);

  const { manifest } = validated;
  const pluginName = manifest.name;

  // Component types are discovered independently so one failing type never
  // suppresses another (§11.3 rule 3).
  const [skills, mcpServers, noeticExtensionDir] = await Promise.all([
    discoverSkills({
      pluginRoot: root,
      pluginName,
      diagnostics,
    }),
    discoverMcpServers({
      pluginRoot: root,
      pluginName,
      diagnostics,
    }),
    findExtensionDir(root),
  ]);

  const noeticExtension = manifest.extensions?.[NOETIC_EXTENSION_NAMESPACE];

  return {
    plugin: {
      manifest,
      root,
      dataDir: join(dataRoot, pluginName),
      skills,
      mcpServers,
      ...(noeticExtension === undefined
        ? {}
        : {
            noeticExtension,
          }),
      ...(noeticExtensionDir === undefined
        ? {}
        : {
            noeticExtensionDir,
          }),
    },
    diagnostics,
  };
}

/**
 * Scan directories for plugins. Each immediate child of each root that
 * contains a `plugin.json` is loaded; children without one are ignored
 * silently, since a plugin root commonly holds unrelated directories.
 *
 * @public
 * @param roots - Directories to scan.
 * @param dataRoot - Base directory under which each plugin's `PLUGIN_DATA` lives.
 */
export async function discoverPlugins(
  roots: readonly string[],
  dataRoot: string,
): Promise<DiscoveryResult> {
  const plugins: LoadedPlugin[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  // A plugin `name` is the key for both PLUGIN_DATA and every qualified id, so
  // two plugins claiming the same name cannot both load.
  const claimed = new Map<string, string>();

  for (const rootDir of roots) {
    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch {
      // A configured root that does not exist yet is a normal state (no
      // plugins installed), not a failure worth reporting per plugin.
      continue;
    }

    for (const entry of entries.sort()) {
      const dir = join(rootDir, entry);
      if ((await classify(dir)) !== FileKind.Directory) {
        continue;
      }
      if ((await classify(join(dir, 'plugin.json'))) === FileKind.Missing) {
        continue;
      }

      const result = await loadPlugin(dir, dataRoot);
      diagnostics.push(...result.diagnostics);
      if (result.plugin === null) {
        continue;
      }

      const name = result.plugin.manifest.name;
      const previous = claimed.get(name);
      if (previous !== undefined) {
        diagnostics.push(
          diagnostic({
            code: DiagnosticCode.PluginRejected,
            pluginDir: result.plugin.root,
            pluginName: name,
            detail: `duplicate plugin name '${name}'; already loaded from ${previous}`,
          }),
        );
        continue;
      }
      claimed.set(name, result.plugin.root);
      plugins.push(result.plugin);
    }
  }

  return {
    plugins,
    diagnostics,
  };
}

//#endregion
