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
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ContextLayer, ContextScope, ExecutionContext } from '@noetic-tools/types';
import { estimateTokens, Slot } from '@noetic-tools/types';
import { z } from 'zod';
import type { PluginDiagnostic } from '../diagnostics';
import { DiagnosticCode, diagnostic } from '../diagnostics';
import type { DiscoveredSkill, LoadedPlugin } from '../discovery';
import { discoverPlugins } from '../discovery';
import type { McpSession, McpToolInfo } from '../mcp-client';
import {
  callMcpTool,
  closeSessions,
  connectMcpServer,
  DEFAULT_CONNECT_TIMEOUT_MS,
} from '../mcp-client';
import type { McpTransport, ResolvedMcpServer } from '../mcp-config';
import { DEFAULT_TRANSPORTS, resolveMcpServer } from '../mcp-config';
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
  /**
   * MCP transports this host will connect. An entry declaring a transport
   * outside this list is skipped per §7.2.2 rule 4. Defaults to
   * {@link DEFAULT_TRANSPORTS} (`stdio` + `streamable-http`); add `'sse'` to
   * opt into the deprecated HTTP+SSE transport.
   */
  transports?: readonly McpTransport[];
  /**
   * Whether to connect MCP servers at all. When `false`, the layer is a
   * skills-only client — still conformant under §11.2 — and the
   * `callMcpTool` function is not exposed to the model.
   */
  connectMcp?: boolean;
  /** Ambient environment for the §9.1 inherited allowlist. Defaults to `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Per-server budget for start + connect + handshake + tools/list. Defaults to
   * {@link DEFAULT_CONNECT_TIMEOUT_MS}. Servers connect concurrently, so this
   * also bounds the whole connect phase.
   */
  connectTimeoutMs?: number;
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

/**
 * How many MCP servers may be connecting at once.
 *
 * Unbounded concurrency is not free: 30 plugins declaring two servers each
 * would launch 60 `npx` processes simultaneously, tens of megabytes apiece.
 * A small pool costs almost no wall clock — startup is dominated by the
 * slowest server, not the queue — and keeps peak memory sane.
 */
const MAX_CONCURRENT_CONNECTS = 8;

//#endregion

//#region State

/**
 * @public Per-thread layer state.
 *
 * Only activation lives here. The discovered index and the live MCP sessions
 * are held on the layer instance instead: the index is identical for every
 * thread and would be pure duplication in durable storage, and a session is a
 * live subprocess or socket that cannot be serialized at all.
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
  servers: ResolvedMcpServer[];
  sessions: McpSession[];
  tools: McpToolInfo[];
  diagnostics: PluginDiagnostic[];
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

function renderServerLine(session: McpSession): string {
  const tools = session.tools.map((tool) => escapeMeta(tool.name)).join(', ');
  return `- ${escapeMeta(session.key)}: ${tools || '(no tools)'}`;
}

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

  if (index.sessions.length > 0) {
    sections.push(
      `<mcp_servers>\nCall callMcpTool to invoke a tool on a connected server.\n${index.sessions
        .map(renderServerLine)
        .join('\n')}\n</mcp_servers>`,
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

//#region Discovery + connection

/**
 * Create a plugin's `PLUGIN_DATA` directory and return its filesystem-resolved
 * path (§9.1). Falls back to the requested path when it cannot be created, so
 * a permissions problem surfaces as a per-server connection failure rather
 * than taking down the whole scan.
 */
async function ensureDataDir(dataDir: string): Promise<string> {
  try {
    await mkdir(dataDir, {
      recursive: true,
    });
  } catch {
    return dataDir;
  }
  return (await resolveRoot(dataDir)) ?? dataDir;
}

/** Run tasks with at most `limit` in flight. Tasks never reject — they report. */
async function runBounded(tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({
    length: Math.min(limit, tasks.length),
  }).map(async () => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (task === undefined) {
        return;
      }
      await task();
    }
  });
  await Promise.all(workers);
}

async function connectServers(params: {
  plugins: readonly LoadedPlugin[];
  transports: readonly McpTransport[];
  baseEnv: Record<string, string | undefined> | undefined;
  connectTimeoutMs: number;
  diagnostics: PluginDiagnostic[];
  /**
   * Sessions are pushed here the moment they open, rather than only being
   * returned at the end. If `init` is aborted partway — the runtime's own init
   * timeout throws — whatever already connected is still reachable for
   * `dispose` to close. Returning them only on success orphaned every
   * subprocess that had started.
   */
  sink: McpSession[];
}): Promise<ResolvedMcpServer[]> {
  const servers: ResolvedMcpServer[] = [];

  // Each plugin's declared entries, flattened, so connects can run
  // concurrently. Serially they cost the sum of every server's startup — with
  // `npx`-launched servers taking seconds apiece, a handful of plugins blew the
  // runtime's 10s init budget and aborted the execution.
  const pending: Array<() => Promise<void>> = [];

  for (const plugin of params.plugins) {
    if (plugin.mcpServers.length === 0) {
      continue;
    }
    const vars = {
      pluginRoot: plugin.root,
      // §9.1 defines PLUGIN_DATA as an *absolute, filesystem-resolved* path,
      // so the directory is created and resolved before it can be substituted
      // into any `args`, `env`, or `cwd` value. Skipped entirely for a plugin
      // with no MCP servers — discovery must not create directories for a
      // plugin that will never launch a subprocess.
      pluginData: await ensureDataDir(plugin.dataDir),
    };

    for (const declared of plugin.mcpServers) {
      if (!params.transports.includes(declared.config.type)) {
        // §7.2.2 rule 4: skip the entry, keep loading the rest.
        params.diagnostics.push(
          diagnostic({
            code: DiagnosticCode.McpTransportUnsupported,
            pluginDir: plugin.root,
            pluginName: plugin.manifest.name,
            component: declared.key,
            detail: `§7.2.2: transport '${declared.config.type}' is not enabled on this host`,
          }),
        );
        continue;
      }

      const resolved = await resolveMcpServer({
        key: declared.qualifiedKey,
        config: declared.config,
        vars,
      });
      if (!resolved.ok) {
        params.diagnostics.push(
          diagnostic({
            code: DiagnosticCode.McpServerInvalid,
            pluginDir: plugin.root,
            pluginName: plugin.manifest.name,
            component: declared.key,
            detail: resolved.detail,
          }),
        );
        continue;
      }
      const server = resolved.server;
      servers.push(server);

      // §7.2.1: client-generated headers win. Resolution already removed them,
      // so this only reports — a plugin author who set `Authorization` and saw
      // it quietly ignored would otherwise have no way to find out.
      for (const dropped of resolved.droppedHeaders) {
        params.diagnostics.push(
          diagnostic({
            code: DiagnosticCode.McpHeaderDropped,
            pluginDir: plugin.root,
            pluginName: plugin.manifest.name,
            component: declared.key,
            detail: dropped.reason,
          }),
        );
      }

      pending.push(async () => {
        const connected = await connectMcpServer({
          server,
          pluginRoot: plugin.root,
          pluginData: vars.pluginData,
          timeoutMs: params.connectTimeoutMs,
          ...(params.baseEnv === undefined
            ? {}
            : {
                baseEnv: params.baseEnv,
              }),
        });
        if (!connected.ok) {
          // §7.2.2 rule 5: a connection failure is isolated to this server.
          params.diagnostics.push(
            diagnostic({
              code: DiagnosticCode.McpConnectFailed,
              pluginDir: plugin.root,
              pluginName: plugin.manifest.name,
              component: declared.key,
              detail: connected.detail,
            }),
          );
          return;
        }
        params.sink.push(connected.session);
      });
    }
  }

  await runBounded(pending, MAX_CONCURRENT_CONNECTS);
  return servers;
}

async function buildIndex(
  config: AgentPluginsConfig,
  sessionSink: McpSession[],
): Promise<PluginIndex> {
  const discovered = await discoverPlugins(config.roots, config.dataDir);
  const diagnostics = [
    ...discovered.diagnostics,
  ];

  const skills = new Map<string, DiscoveredSkill>();
  for (const plugin of discovered.plugins) {
    for (const skill of plugin.skills) {
      skills.set(skill.qualifiedId, skill);
    }
  }

  const connectMcp = config.connectMcp !== false;
  const servers = connectMcp
    ? await connectServers({
        plugins: discovered.plugins,
        transports: config.transports ?? DEFAULT_TRANSPORTS,
        baseEnv: config.baseEnv,
        connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        diagnostics,
        sink: sessionSink,
      })
    : [];

  return {
    plugins: discovered.plugins,
    skills,
    servers,
    sessions: sessionSink,
    tools: sessionSink.flatMap((session) => session.tools),
    diagnostics,
  };
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

const CallMcpToolInput = z.object({
  server: z.string().describe("Server key — '<plugin>/<server>'."),
  tool: z.string().describe('Tool name as the server declares it.'),
  arguments: z.record(z.string(), z.unknown()).optional().describe('Tool arguments.'),
});

const CallMcpToolOutput = z.object({
  ok: z.boolean(),
  content: z.unknown().optional(),
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
  /** Tools exposed by connected MCP servers. */
  readMcpTools(): readonly McpToolInfo[];
}

/**
 * Create the Agent Plugins context layer.
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
  // The index is install-level, not thread-level: rescanning per thread would
  // relaunch every stdio server.
  let indexPromise: Promise<PluginIndex> | undefined;
  /**
   * Every session opened by this instance, recorded as it opens. `dispose` has
   * to be able to close subprocesses started by an `init` that was aborted
   * before it returned — reading them off the finished index closed nothing,
   * because there was no finished index.
   */
  const liveSessions: McpSession[] = [];
  let index: PluginIndex | undefined;
  // Sessions are owned by the instance, not by any one scope. Counting live
  // inits stops the first thread to finish from tearing down subprocesses the
  // other threads are still using.
  let liveScopes = 0;

  const load = async (): Promise<PluginIndex> => {
    // `??=` alone memoized a *rejected* promise forever, so one failed scan
    // poisoned the layer for the life of the process. Clearing on rejection
    // lets the next init retry; the assignment is still synchronous, so
    // concurrent inits continue to share one scan rather than double-spawning.
    indexPromise ??= buildIndex(config, liveSessions)
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
      sessions: [],
      tools: [],
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

    // The runtime's default init budget is 10s, which is not enough to scan
    // plugin roots and complete a handshake with every declared MCP server.
    // Exceeding it does not degrade this layer — it throws, aborting the whole
    // execution — so the budget is raised to sit above the per-server connect
    // timeout rather than under it.
    timeouts: {
      init: 6e4,
    },
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
      mcpTools: {
        kind: 'data',
        read: () => currentIndex().tools,
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

      ...(config.connectMcp === false
        ? {}
        : {
            callMcpTool: {
              kind: 'function' as const,
              description:
                'Invoke a tool on a connected MCP server. Server keys and tool names are listed in <agent_plugins>.',
              input: CallMcpToolInput,
              output: CallMcpToolOutput,
              async execute(args: z.infer<typeof CallMcpToolInput>) {
                const loaded = await load();
                const session = loaded.sessions.find((entry) => entry.key === args.server);
                if (session === undefined) {
                  return {
                    result: {
                      ok: false,
                      error: `no connected MCP server '${args.server}'. Connected: ${loaded.sessions.map((s) => s.key).join(', ') || '(none)'}`,
                    },
                  };
                }
                const outcome = await callMcpTool({
                  session,
                  tool: args.tool,
                  args: args.arguments ?? {},
                });
                return {
                  result: {
                    ok: outcome.ok,
                    content: outcome.content,
                    // The output schema advertises `error`, so a failing call
                    // has to populate it. Returning only `{ok:false, content}`
                    // left the model to infer the failure from the payload.
                    ...(outcome.ok
                      ? {}
                      : {
                          error: `MCP tool '${args.tool}' on '${args.server}' reported a failure`,
                        }),
                  },
                };
              },
            },
          }),
    },

    hooks: {
      async init({ ctx }) {
        // Counted BEFORE the await. Incrementing afterwards meant a failed scan
        // skipped the increment while the matching dispose still decremented,
        // driving the count negative so that a later, genuinely-live scope was
        // torn down at what looked like zero.
        liveScopes += 1;
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

      async dispose() {
        // Floored at zero. `DisposeParams` carries no scope identity, so this
        // is a count rather than a set — and an unmatched dispose used to drive
        // it negative, which then made the *next* dispose tear down sessions a
        // live scope was still using. Clamping keeps an extra dispose inert.
        liveScopes = Math.max(0, liveScopes - 1);
        if (liveScopes > 0) {
          return;
        }
        // Closed from the instance-level sink rather than from `index`, so an
        // init that was aborted partway still has its subprocesses reaped.
        await closeSessions([
          ...liveSessions,
        ]);
        liveSessions.length = 0;
        if (index !== undefined) {
          // Sessions are gone, but the discovered plugins, skills and
          // diagnostics are not — a host collects diagnostics at end-of-run,
          // which is after teardown, and blanking these returned it nothing.
          index.sessions = [];
          index.tools = [];
        }
        indexPromise = undefined;
      },
    },

    readPlugins: () => currentIndex().plugins,
    readDiagnostics: () => currentIndex().diagnostics,
    readMcpTools: () => currentIndex().tools,
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
