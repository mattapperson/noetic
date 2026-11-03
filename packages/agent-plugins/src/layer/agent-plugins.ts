/**
 * The `agentPlugins()` context layer — an Agent Plugins v1 client wired into
 * Noetic's recall/store lifecycle.
 *
 * The layer's shape follows the progressive disclosure model the Agent Skills
 * specification prescribes, mapped onto the parts of a context layer that can
 * express it:
 *
 *   1. **Metadata** — every skill's `name` and `description` sit in `recall`
 *      output on every turn. That is what lets the model know a skill exists.
 *   2. **Instructions** — a `SKILL.md` body enters the context only when
 *      `loadSkill` is called, and stays for the rest of the thread.
 *   3. **Resources** — `scripts/`, `references/`, and `assets/` files are read
 *      one at a time through `readSkillResource`.
 *
 * The index is stable for the life of the process, so it belongs in the
 * `'anchor'` band where the prompt cache can keep it. Activating a skill is the
 * only thing that changes the block.
 *
 * `renderDelta` republishes the block in full rather than emitting just the new
 * skill. The runtime publishes a delta under `action="replace"` ("these
 * supersede the blocks with the same layer id"), so a partial delta would tell
 * the model that the index and every earlier activation had been superseded by
 * a block containing none of them. The saving is not payload size — it is that
 * the anchored prefix stays byte-identical, so the prompt cache still hits.
 *
 * A change landing on a turn where the runtime re-anchors is folded into fresh
 * pins rather than published, since a new epoch has nothing to supersede. That
 * is common early on, while the runtime is still probing whether the provider
 * caches at all; it settles once the provider is judged. Either way the model
 * sees the change, so the cost is a prefix rewrite rather than lost content.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ContextLayer, ContextScope, ExecutionContext } from '@noetic-tools/types';
import { estimateTokens, Slot } from '@noetic-tools/types';
import { z } from 'zod';
import type { PluginDiagnostic } from '../diagnostics';
import type { DiscoveredSkill, LoadedPlugin } from '../discovery';
import { discoverPlugins } from '../discovery';
import { pluginConnectionName } from '../mcp-client';
import { containedPath, resolveRoot } from '../paths';

//#region Configuration

/** @public Configuration for {@link agentPlugins}. */
export interface AgentPluginsConfig {
  /**
   * Directories to scan. Each immediate child holding a `plugin.json` is
   * loaded as a plugin; children without one are ignored.
   */
  roots: readonly string[];
  /**
   * Base directory for per-plugin `PLUGIN_DATA` (§9.1). Each plugin gets
   * `<dataDir>/<plugin-name>`, created before its first subprocess launches
   * and preserved across plugin updates.
   */
  dataDir: string;
  slot?: number;
  scope?: ContextScope;
  budget?: ContextLayer['budget'];
}

/** @public The layer id, and the key `ctx.context[…]` exposes its handle under. */
export const AGENT_PLUGINS_LAYER_ID = 'agent-plugins';

/** Bodies are read once at discovery; a skill dir is not walked deeper than this. */
const MAX_RESOURCE_DEPTH = 3;

/** Cap on the resource paths reported for one skill, so a huge asset tree cannot flood the reply. */
const MAX_RESOURCES = 200;

/** Cap on a single resource read, mirroring the guard the file-reference layer uses. */
const MAX_RESOURCE_BYTES = 1024 * 1024;

//#endregion

//#region State

/**
 * @public Per-thread layer state.
 *
 * Only activation lives here. The discovered index is held on the layer
 * instance instead: it is identical for every thread and would be pure
 * duplication in durable storage.
 */
export interface AgentPluginsState {
  /** Qualified ids of skills activated in this thread, oldest first. */
  activated: string[];
}

/** The discovery result plus everything derived from it, computed once per layer instance. */
interface PluginIndex {
  plugins: LoadedPlugin[];
  /** Keyed by qualified id (`<plugin>/<skill>`). */
  skills: Map<string, DiscoveredSkill>;
  servers: PluginServer[];
  diagnostics: PluginDiagnostic[];
}

/** @public A plugin's MCP server and the connection `pluginConnections()` names it. */
export interface PluginServer {
  /** `<plugin>/<server>`. */
  server: string;
  connection: string;
}

function emptyState(): AgentPluginsState {
  return {
    activated: [],
  };
}

//#endregion

//#region Skill lookup

/**
 * Resolve a skill reference to its qualified id.
 *
 * A model will naturally write the bare skill name, so a bare name resolves
 * when exactly one plugin provides it. When two plugins provide the same skill
 * name the reference is genuinely ambiguous, and guessing would silently run
 * the wrong instructions — so it reports the candidates instead.
 */
function resolveSkillRef(
  index: PluginIndex,
  ref: string,
):
  | {
      ok: true;
      skill: DiscoveredSkill;
    }
  | {
      ok: false;
      detail: string;
    } {
  const exact = index.skills.get(ref);
  if (exact !== undefined) {
    return {
      ok: true,
      skill: exact,
    };
  }

  const matches = [
    ...index.skills.values(),
  ].filter((skill) => skill.id === ref);
  if (matches.length === 1 && matches[0] !== undefined) {
    return {
      ok: true,
      skill: matches[0],
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      detail: `'${ref}' is ambiguous — provided by ${matches.map((s) => s.qualifiedId).join(', ')}. Use the qualified '<plugin>/<skill>' form.`,
    };
  }
  return {
    ok: false,
    detail: `no skill named '${ref}'. Available: ${
      [
        ...index.skills.keys(),
      ].join(', ') || '(none)'
    }`,
  };
}

/**
 * List the files a skill bundles, as paths relative to the skill directory.
 * These are the tier-3 resources the model can pull in with
 * `readSkillResource`; `SKILL.md` itself is excluded because its content is
 * already what activation delivered.
 */
/**
 * Cache of skill directory → bundled resource paths.
 *
 * The walk costs up to `MAX_RESOURCES` round trips and ran on *every*
 * `loadSkill`, including re-activation of a skill already in context — inside a
 * model tool call, where latency is felt. The skill set is fixed for the life
 * of the process (discovery runs once), so the answer cannot change.
 */
const resourceCache = new Map<string, string[]>();

async function listSkillResources(skillDir: string): Promise<string[]> {
  const cached = resourceCache.get(skillDir);
  if (cached !== undefined) {
    return cached;
  }
  // Resolve the root once. Every reported path is a `relative()` against this,
  // so the names handed to the model are the ones they can pass back.
  const base = await resolveRoot(skillDir);
  if (base === null) {
    return [];
  }
  const found: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_RESOURCE_DEPTH || found.length >= MAX_RESOURCES) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_RESOURCES) {
        return;
      }
      const full = join(dir, entry.name);

      // Only a symlink can leave the tree. Everything else is contained by
      // construction, since its parent already is — so containment is checked
      // where it can actually fail rather than on every entry, and the entry
      // keeps the name it was found under. Resolving each entry to its target
      // instead made an in-root `references -> shared/` report paths under
      // `shared/…` that the model never saw, and enumerate them twice.
      if (entry.isSymbolicLink()) {
        const contained = await containedPath(base, full);
        if (!contained.ok) {
          continue;
        }
      }

      let isDir: boolean;
      if (entry.isSymbolicLink()) {
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
      } else {
        isDir = entry.isDirectory();
      }

      if (isDir) {
        await walk(full, depth + 1);
        continue;
      }
      const rel = relative(base, full).split(sep).join('/');
      if (rel === 'SKILL.md') {
        continue;
      }
      found.push(rel);
    }
  };

  await walk(base, 0);
  resourceCache.set(skillDir, found);
  return found;
}

//#endregion

//#region Rendering

/**
 * The container tags this layer emits. Plugin text must not be able to forge
 * one, so the neutralizing pattern is built from this list rather than
 * restating it — adding a section below without updating a second hand-written
 * regex would quietly reopen the injection hole.
 */
const OWN_TAGS = [
  'agent_plugins',
  'plugins',
  'skills',
  'mcp_servers',
  'active_skills',
  'skill',
] as const;

const OWN_TAG_PATTERN = new RegExp(`<(/?)(${OWN_TAGS.join('|')})\\b`, 'gi');

/**
 * Escape a short, plugin-controlled metadata string.
 *
 * These lines sit in the index, which is anchored into *every* turn for every
 * installed plugin — no activation required. A `description` is up to 1024
 * attacker-chosen characters, so without escaping a plugin could close this
 * layer's own tags and append text the model reads as a system instruction.
 * Metadata is prose, never markup, so full escaping costs nothing.
 */
function escapeMeta(text: string): string {
  // Only the angle brackets matter: nothing downstream decodes entities, so
  // escaping `&` as well would turn "Tom & Jerry" into "Tom &amp; Jerry" in
  // every description for no security benefit.
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Neutralize only this layer's own container tags inside free-form text.
 *
 * A skill body is instructions the author wrote for a model, and it legitimately
 * contains markup and code — escaping every angle bracket would mangle it. The
 * breakout vector is narrower than that: forging one of the tags this layer
 * itself emits. Rewriting just those keeps `<div>` and `<T>` intact while making
 * `</agent_plugins>` inert.
 */
function neutralizeOwnTags(text: string): string {
  return text.replace(
    OWN_TAG_PATTERN,
    (_match, slash: string, tag: string) => `&lt;${slash}${tag}`,
  );
}

function renderPluginLine(plugin: LoadedPlugin): string {
  const version =
    plugin.manifest.version === undefined ? '' : ` v${escapeMeta(plugin.manifest.version)}`;
  const description =
    plugin.manifest.description === undefined
      ? ''
      : ` — ${escapeMeta(plugin.manifest.description)}`;
  return `- ${plugin.manifest.name}${version}${description}`;
}

function renderSkillLine(skill: DiscoveredSkill): string {
  // `qualifiedId` is `<plugin>/<skill>`, and both halves are constrained to
  // `[a-z0-9.-]` by their own name rules, so only the description is hostile.
  return `- ${skill.qualifiedId}: ${escapeMeta(skill.frontmatter.description)}`;
}

function renderServerLine(entry: PluginServer): string {
  // The connection name is confined to `[A-Za-z0-9_-]`; the server key is not.
  return `- ${escapeMeta(entry.server)}: connection ${entry.connection}`;
}

/**
 * How the model reaches a plugin server. Every server is an `expose: 'call'`
 * connection, and two or more of those share one `ops` and one `call`, so the
 * hint names both forms rather than guessing which one this turn has.
 */
const SERVERS_HINT =
  'Each server is a connection. List its operations with <connection>_ops and run one with <connection>_call. When several connections share them, the tools are ops and call, with target naming the connection.';

function renderActivatedSkill(skill: DiscoveredSkill): string {
  return `<skill id="${skill.qualifiedId}">\n${neutralizeOwnTags(skill.body)}\n</skill>`;
}

/**
 * Build the `<agent_plugins>` block.
 *
 * `activated` is passed separately from the index because budget degradation
 * works by re-rendering with fewer activated bodies — the oldest activation is
 * the one the model is least likely to still be working from.
 */
function renderBlock(index: PluginIndex, activated: DiscoveredSkill[]): string {
  const sections: string[] = [];

  if (index.plugins.length > 0) {
    sections.push(`<plugins>\n${index.plugins.map(renderPluginLine).join('\n')}\n</plugins>`);
  }

  if (index.skills.size > 0) {
    const lines = [
      ...index.skills.values(),
    ]
      .map(renderSkillLine)
      .join('\n');
    sections.push(
      `<skills>\nCall loadSkill with a skill id to read its full instructions.\n${lines}\n</skills>`,
    );
  }

  if (index.servers.length > 0) {
    sections.push(
      `<mcp_servers>\n${SERVERS_HINT}\n${index.servers.map(renderServerLine).join('\n')}\n</mcp_servers>`,
    );
  }

  if (activated.length > 0) {
    sections.push(
      `<active_skills>\n${activated.map(renderActivatedSkill).join('\n')}\n</active_skills>`,
    );
  }

  if (sections.length === 0) {
    return '';
  }
  return `<agent_plugins>\n${sections.join('\n')}\n</agent_plugins>`;
}

/**
 * Render within a token budget, shedding the least useful content first:
 * oldest activated bodies, then the skill index, then a hard trim.
 */
function renderWithinBudget(params: {
  index: PluginIndex;
  activated: DiscoveredSkill[];
  budget: number;
}): string {
  const { index, budget } = params;
  let activated = params.activated;
  let text = renderBlock(index, activated);

  // `budget > 0` is the fail-open convention shared with staticContent and
  // openUiSurface: a zero allocation must not delete the layer from the view.
  if (budget <= 0) {
    return text;
  }

  while (estimateTokens(text) > budget && activated.length > 0) {
    activated = activated.slice(1);
    text = renderBlock(index, activated);
  }
  if (estimateTokens(text) > budget) {
    const closing = '\n</agent_plugins>';
    const maxChars = Math.max(0, budget * 4 - closing.length);
    text = `${text.slice(0, maxChars)}${closing}`;
  }
  return text;
}

//#endregion

//#region Discovery

async function buildIndex(config: AgentPluginsConfig): Promise<PluginIndex> {
  const discovered = await discoverPlugins(config.roots, config.dataDir);
  const skills = new Map<string, DiscoveredSkill>();
  for (const plugin of discovered.plugins) {
    for (const skill of plugin.skills) {
      skills.set(skill.qualifiedId, skill);
    }
  }
  return {
    plugins: discovered.plugins,
    skills,
    servers: discovered.plugins.flatMap(serversOf),
    diagnostics: discovered.diagnostics,
  };
}

function serversOf(plugin: LoadedPlugin): PluginServer[] {
  return plugin.mcpServers.flatMap((declared) => {
    const connection = pluginConnectionName(plugin.manifest.name, declared.key);
    return connection === undefined
      ? []
      : [
          {
            server: declared.qualifiedKey,
            connection,
          },
        ];
  });
}

//#endregion

//#region Function schemas

const LoadSkillInput = z.object({
  skill: z
    .string()
    .describe("Skill id — '<plugin>/<skill>', or the bare skill name when unambiguous."),
});

const LoadSkillOutput = z.object({
  ok: z.boolean(),
  skill: z.string().optional(),
  /** The SKILL.md body. Also stays in context for the rest of the thread. */
  instructions: z.string().optional(),
  /** Bundled files readable with `readSkillResource`. */
  resources: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const ReadSkillResourceInput = z.object({
  skill: z.string().describe("Skill id — '<plugin>/<skill>', or the bare skill name."),
  path: z
    .string()
    .describe("Path relative to the skill directory, e.g. 'references/REFERENCE.md'."),
});

const ReadSkillResourceOutput = z.object({
  ok: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
});

//#endregion

//#region Layer

/** @public The layer plus a read handle onto the discovery result for host-side wiring. */
export interface AgentPluginsLayer extends ContextLayer<AgentPluginsState> {
  /** Loaded plugins, or `[]` before `init` runs. */
  readPlugins(): readonly LoadedPlugin[];
  /** Everything that was skipped or rejected, and why (§11.3). */
  readDiagnostics(): readonly PluginDiagnostic[];
}

/**
 * Create the Agent Plugins context layer: the skills, and the list of plugin
 * MCP servers with the connection each one is. The servers themselves reach
 * the model as connections the host attaches with {@link pluginConnections}.
 *
 * @public
 * @example
 * ```ts
 * const layer = agentPlugins({
 *   roots: ['/home/alex/.agents/plugins'],
 *   dataDir: '/home/alex/.agents/plugins-data',
 * });
 * ```
 */
export function agentPlugins(config: AgentPluginsConfig): AgentPluginsLayer {
  // One scan per layer instance, shared by every scope that inits against it.
  // The index is install-level, not thread-level.
  let indexPromise: Promise<PluginIndex> | undefined;
  let index: PluginIndex | undefined;

  const load = async (): Promise<PluginIndex> => {
    // `??=` alone memoized a *rejected* promise forever, so one failed scan
    // poisoned the layer for the life of the process. Clearing on rejection
    // lets the next init retry; the assignment is still synchronous, so
    // concurrent inits continue to share one scan rather than double-spawning.
    indexPromise ??= buildIndex(config)
      .then((built) => {
        index = built;
        return built;
      })
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    return indexPromise;
  };

  const currentIndex = (): PluginIndex =>
    index ?? {
      plugins: [],
      skills: new Map(),
      servers: [],
      diagnostics: [],
    };

  const activatedSkills = (state: AgentPluginsState | undefined): DiscoveredSkill[] => {
    const loaded = currentIndex();
    return (state?.activated ?? [])
      .map((id) => loaded.skills.get(id))
      .filter((skill): skill is DiscoveredSkill => skill !== undefined);
  };

  return {
    id: AGENT_PLUGINS_LAYER_ID,
    name: 'Agent Plugins',
    // Skills are procedural knowledge — how to carry out a task — which is
    // exactly what this slot is for.
    slot: config.slot ?? Slot.PROCEDURAL,
    // 'thread': the plugin set is fixed for the process, but which skills are
    // active is conversation state and must survive resume.
    scope: config.scope ?? 'thread',
    budget: config.budget ?? {
      min: 200,
      max: 4000,
    },
    // The index is byte-identical every turn, so it belongs in the cached
    // prefix. Activation is the only mutation, and renderDelta handles it.
    placement: 'anchor',

    // Plugins are enrichment, not load-bearing context. If discovery fails
    // outright the right outcome is an agent with no skills and a diagnostic,
    // not a dead execution.
    onInitError: 'disable',

    provides: {
      plugins: {
        kind: 'data',
        read: () => currentIndex().plugins,
      },
      skills: {
        kind: 'data',
        read: () => [
          ...currentIndex().skills.values(),
        ],
      },
      mcpServers: {
        kind: 'data',
        read: () => currentIndex().servers,
      },
      diagnostics: {
        kind: 'data',
        read: () => currentIndex().diagnostics,
      },
      activeSkills: {
        kind: 'data',
        read: (state: AgentPluginsState) => state?.activated ?? [],
      },

      loadSkill: {
        kind: 'function',
        description:
          "Load a skill's full instructions. The instructions stay available for the rest of the conversation. Use the skill index in <agent_plugins> to pick one.",
        input: LoadSkillInput,
        output: LoadSkillOutput,
        async execute(args: z.infer<typeof LoadSkillInput>, state: AgentPluginsState) {
          const loaded = await load();
          const found = resolveSkillRef(loaded, args.skill);
          if (!found.ok) {
            return {
              result: {
                ok: false,
                error: found.detail,
              },
            };
          }

          const resources = await listSkillResources(found.skill.directory);
          const current = state ?? emptyState();
          // Re-activating is a no-op rather than a duplicate: the body is
          // already in the view, and appending it twice would double its cost.
          const activated = current.activated.includes(found.skill.qualifiedId)
            ? current.activated
            : [
                ...current.activated,
                found.skill.qualifiedId,
              ];

          return {
            result: {
              ok: true,
              skill: found.skill.qualifiedId,
              instructions: found.skill.body,
              resources,
            },
            state: {
              ...current,
              activated,
            },
          };
        },
      },

      readSkillResource: {
        kind: 'function',
        description:
          "Read one file bundled with a skill (scripts/, references/, assets/). Paths come from loadSkill's `resources` list.",
        input: ReadSkillResourceInput,
        output: ReadSkillResourceOutput,
        async execute(args: z.infer<typeof ReadSkillResourceInput>) {
          const loaded = await load();
          const found = resolveSkillRef(loaded, args.skill);
          if (!found.ok) {
            return {
              result: {
                ok: false,
                error: found.detail,
              },
            };
          }

          // An absolute path would be silently reparented under the skill
          // directory by `join`, producing an ENOENT that names a path nobody
          // asked for and leaks the absolute skill directory. Say what is
          // actually wrong instead.
          if (isAbsolute(args.path)) {
            return {
              result: {
                ok: false,
                error: `'${args.path}' must be relative to the skill directory, not absolute`,
              },
            };
          }

          // §4.1 rule 5: a package path resolving outside the plugin root is
          // denied. Containment is against the skill directory, which is
          // stricter and stops one skill reading another's files.
          const contained = await containedPath(
            found.skill.directory,
            join(found.skill.directory, args.path),
          );
          if (!contained.ok) {
            return {
              result: {
                ok: false,
                error: `'${args.path}' is not readable inside skill '${found.skill.qualifiedId}' (${contained.reason})`,
              },
            };
          }

          try {
            const stats = await stat(contained.path);
            if (!stats.isFile()) {
              return {
                result: {
                  ok: false,
                  error: `'${args.path}' is not a regular file`,
                },
              };
            }
            if (stats.size > MAX_RESOURCE_BYTES) {
              return {
                result: {
                  ok: false,
                  error: `'${args.path}' is ${stats.size} bytes, over the ${MAX_RESOURCE_BYTES}-byte limit`,
                },
              };
            }
            return {
              result: {
                ok: true,
                content: await readFile(contained.path, 'utf8'),
              },
            };
          } catch (error) {
            return {
              result: {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        },
      },
    },

    hooks: {
      async init({ ctx }) {
        const loaded = await load();
        reportDiagnostics(ctx, loaded.diagnostics);
        return {
          state: emptyState(),
        };
      },

      async recall({ state, budget }) {
        const loaded = currentIndex();
        if (loaded.plugins.length === 0) {
          return null;
        }
        return renderWithinBudget({
          index: loaded,
          activated: activatedSkills(state),
          budget,
        });
      },

      async renderDelta({ prevState, state, budget }) {
        const before = new Set(prevState?.activated ?? []);
        const after = state?.activated ?? [];
        if (after.length === before.size && after.every((id) => before.has(id))) {
          // Nothing changed, so the pinned block is still accurate. Returning
          // `null` hands the runtime its default, which republishes the block
          // in full — correct, just wasteful, and unnecessary here.
          return null;
        }

        // The whole block, not just what changed.
        //
        // The runtime publishes this under `action="replace"` with the header
        // "These supersede the blocks with the same layer id earlier in this
        // context." Returning only the newly activated skill therefore told the
        // model that the plugin list, the entire skill index, and every
        // previously loaded skill had been superseded by a block containing
        // none of them — silently deleting the index it needs to find anything.
        //
        // The saving was never in the payload size: it is that the anchored
        // prefix stays byte-identical, so the prompt cache still hits and the
        // correction is appended rather than rewritten in place.
        const text = renderWithinBudget({
          index: currentIndex(),
          activated: activatedSkills(state),
          budget,
        });
        return text.length === 0 ? null : text;
      },

      async onSpawn({ parentState }) {
        // A child sees the same skill index and inherits what the parent
        // activated, but its own activations stay local — see `onReturn`.
        return {
          childState: {
            activated: [
              ...(parentState?.activated ?? []),
            ],
          },
          items: [],
        };
      },

      async onReturn({ parentState }) {
        // Activation is a statement about what *this* conversation is working
        // from. A child that consulted a skill to answer one question should
        // not permanently pin that skill's instructions into the parent.
        return {
          parentState: parentState ?? emptyState(),
        };
      },
    },

    readPlugins: () => currentIndex().plugins,
    readDiagnostics: () => currentIndex().diagnostics,
  };
}

/**
 * Mirror diagnostics onto the execution trace so a skipped skill or a server
 * that would not start is visible in observability, not only to a caller who
 * thinks to read `provides.diagnostics`.
 */
function reportDiagnostics(ctx: ExecutionContext, diagnostics: readonly PluginDiagnostic[]): void {
  for (const entry of diagnostics) {
    ctx.trace.addEvent('agent-plugins.diagnostic', {
      code: entry.code,
      pluginDir: entry.pluginDir,
      ...(entry.pluginName === undefined
        ? {}
        : {
            pluginName: entry.pluginName,
          }),
      ...(entry.component === undefined
        ? {}
        : {
            component: entry.component,
          }),
      detail: entry.detail,
    });
  }
}

//#endregion
