/**
 * Fixture helpers: real plugin trees in real temp directories.
 *
 * The spec's containment rules are about what the *filesystem* resolves a path
 * to, so an in-memory fake would not exercise the thing under test — a symlink
 * escape only means anything when there is a symlink. Every fixture here is
 * written to disk and removed afterwards.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ContextLayer,
  ExecutionContext,
  FsAdapter,
  ScopedStorage,
  ShellAdapter,
} from '@noetic-tools/types';
import { estimateTokens } from '@noetic-tools/types';
import { z } from 'zod';
import { PLUGIN_SCHEMA_ID } from '../src/manifest';
import { MCP_SCHEMA_ID } from '../src/mcp-config';

//#region Temp directories

const created: string[] = [];

/** Make a temp directory that {@link cleanupFixtures} will remove. */
export async function tempDir(prefix = 'agent-plugins-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  // Resolved up front: the spec decides containment on filesystem-resolved
  // paths, and the system temp directory is itself a symlink on macOS
  // (/var -> /private/var). Handing tests an unresolved root would make every
  // resolved path look like an escape.
  return realpath(dir);
}

/** Remove every directory created by {@link tempDir}. Call from `afterAll`. */
export async function cleanupFixtures(): Promise<void> {
  await Promise.all(
    created.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
}

//#endregion

//#region Fixture building

/** Write a file, creating parent directories as needed. */
export async function writeFixture(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await writeFile(path, content, 'utf8');
}

/** A `plugin.json` with the canonical `$schema` and any extra fields merged in. */
export function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      $schema: PLUGIN_SCHEMA_ID,
      name,
      ...extra,
    },
    null,
    2,
  );
}

/** An `mcp.json` with the canonical `$schema`, unless a different one is given. */
export function mcpConfig(
  servers: Record<string, unknown>,
  schemaId: string = MCP_SCHEMA_ID,
): string {
  return JSON.stringify(
    {
      $schema: schemaId,
      mcpServers: servers,
    },
    null,
    2,
  );
}

/** A minimal conforming `SKILL.md`. */
export function skillDoc(params: {
  name: string;
  description?: string;
  body?: string;
  /** Extra frontmatter lines, each already newline-terminated. */
  extraFrontmatter?: string;
}): string {
  const description =
    params.description ?? `Does ${params.name} things. Use when the user mentions ${params.name}.`;
  const body = params.body ?? `# ${params.name}\n\nInstructions for ${params.name}.`;
  return `---\nname: ${params.name}\ndescription: ${description}\n${params.extraFrontmatter ?? ''}---\n${body}`;
}

/** Description of a plugin to materialize on disk. */
export interface PluginSpec {
  /** Directory name. Defaults to the manifest name. */
  dir?: string;
  /** Raw `plugin.json` contents. Pass a non-JSON string to test parse failure. */
  manifest: string;
  /** Skill directory name → `SKILL.md` contents. */
  skills?: Record<string, string>;
  /** Extra files, keyed by plugin-relative path. */
  files?: Record<string, string>;
  /** Raw `mcp.json` contents. */
  mcp?: string;
}

/** Just enough of a manifest to pick a directory name from. */
const NamedManifestSchema = z.object({
  name: z.string().min(1),
});

/**
 * Best-effort name extraction for choosing a directory name. Fixtures that
 * deliberately carry a broken manifest fall back to a fixed directory name.
 */
function readManifestName(raw: string): string {
  try {
    const parsed = NamedManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.name : 'broken-plugin';
  } catch {
    return 'broken-plugin';
  }
}

/**
 * Materialize plugins under a fresh root directory.
 *
 * @returns The root to scan and the data directory to use for `PLUGIN_DATA`.
 */
export async function makePluginRoot(plugins: readonly PluginSpec[]): Promise<{
  root: string;
  dataDir: string;
}> {
  const base = await tempDir();
  const root = join(base, 'plugins');
  const dataDir = join(base, 'data');
  await mkdir(root, {
    recursive: true,
  });
  await mkdir(dataDir, {
    recursive: true,
  });

  for (const spec of plugins) {
    const name = spec.dir ?? readManifestName(spec.manifest);
    const pluginDir = join(root, name);
    await mkdir(pluginDir, {
      recursive: true,
    });
    await writeFile(join(pluginDir, 'plugin.json'), spec.manifest, 'utf8');

    for (const [skillName, doc] of Object.entries(spec.skills ?? {})) {
      await writeFixture(join(pluginDir, 'skills', skillName, 'SKILL.md'), doc);
    }
    for (const [path, content] of Object.entries(spec.files ?? {})) {
      await writeFixture(join(pluginDir, path), content);
    }
    if (spec.mcp !== undefined) {
      await writeFile(join(pluginDir, 'mcp.json'), spec.mcp, 'utf8');
    }
  }

  return {
    root,
    dataDir,
  };
}

/** Create a symlink, including the directories leading up to it. */
export async function linkFixture(
  linkPath: string,
  target: string,
  type: 'file' | 'dir' = 'dir',
): Promise<void> {
  await mkdir(dirname(linkPath), {
    recursive: true,
  });
  await symlink(target, linkPath, type);
}

//#endregion

//#region Execution context

/** Trace events a fake context recorded, for asserting on diagnostics reporting. */
export interface RecordedEvent {
  name: string;
  attributes: Record<string, string | number | boolean> | undefined;
}

/**
 * Adapters that throw if touched.
 *
 * This package reads the filesystem through `node:fs/promises` directly — it
 * has to, since a conformant MCP client spawns subprocesses and §4.1
 * containment needs `realpath`, neither of which `FsAdapter` exposes. Stubs
 * that throw make that a fact the tests enforce: if the layer ever starts
 * routing I/O through `ctx.fs`, these turn it into a loud failure rather than
 * a silent platform-coupling regression.
 */
function unusedAdapter(name: string): never {
  throw new Error(`${name} was called, but @noetic-tools/agent-plugins does not use it`);
}

const throwingFs: FsAdapter = {
  readFile: () => unusedAdapter('FsAdapter.readFile'),
  readFileText: () => unusedAdapter('FsAdapter.readFileText'),
  writeFile: () => unusedAdapter('FsAdapter.writeFile'),
  writeFileBytes: () => unusedAdapter('FsAdapter.writeFileBytes'),
  appendFile: () => unusedAdapter('FsAdapter.appendFile'),
  mkdir: () => unusedAdapter('FsAdapter.mkdir'),
  rename: () => unusedAdapter('FsAdapter.rename'),
  rm: () => unusedAdapter('FsAdapter.rm'),
  access: () => unusedAdapter('FsAdapter.access'),
  stat: () => unusedAdapter('FsAdapter.stat'),
  lstat: () => unusedAdapter('FsAdapter.lstat'),
  readdir: () => unusedAdapter('FsAdapter.readdir'),
};

const throwingShell: ShellAdapter = {
  exec: () => unusedAdapter('ShellAdapter.exec'),
};

/**
 * A real `ExecutionContext` — every field present, no casts — carrying a
 * recording trace so tests can assert that diagnostics are reported (§11.3).
 */
export function fakeExecutionContext(): {
  ctx: ExecutionContext;
  events: RecordedEvent[];
} {
  const events: RecordedEvent[] = [];
  const ctx: ExecutionContext = {
    executionId: 'exec-test',
    threadId: 'thread-test',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    fs: throwingFs,
    shell: throwingShell,
    tokenize: estimateTokens,
    trace: {
      setAttribute: () => {},
      addEvent: (name, attributes) => {
        events.push({
          name,
          attributes,
        });
      },
    },
    readLayerState: () => undefined,
  };
  return {
    ctx,
    events,
  };
}

//#endregion

//#region Layer harness

/**
 * Scoped storage that stores nothing.
 *
 * This layer keeps only activation in durable state and reads none of it back
 * at init, so every suite was writing the same five-method stub inline. Shared
 * here rather than copied, matching `packages/core/test/_helpers.ts`.
 */
export function makeScopedStorage(): ScopedStorage {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
    getMany: async () => new Map(),
  };
}

/** Run a layer's `init` and hand back the recording context it was given. */
export async function startLayer(layer: ContextLayer): Promise<{
  ctx: ExecutionContext;
  events: RecordedEvent[];
}> {
  const { ctx, events } = fakeExecutionContext();
  await layer.hooks.init?.({
    storage: makeScopedStorage(),
    scopeKey: 'thread:test',
    ctx,
  });
  return {
    ctx,
    events,
  };
}

/** Recall a layer and return its rendered text (`''` when it declines to render). */
export async function recallLayer(
  layer: ContextLayer,
  state: unknown,
  budget = 8000,
): Promise<string> {
  const { ctx } = fakeExecutionContext();
  const result = await layer.hooks.recall?.({
    log: {
      items: [],
      append: () => {},
    },
    query: '',
    ctx,
    state,
    budget,
  });
  if (result === null || result === undefined) {
    return '';
  }
  return typeof result === 'string' ? result : '';
}

/**
 * Narrow a `provides` entry to a callable.
 *
 * The contract types `provides` as a union of data and function declarations,
 * so a test has to discriminate before invoking one. A wrapper rather than the
 * declaration itself: `LayerFunctionDecl` is invariant in its argument types,
 * so the erased `unknown` form the union carries will not assign to a narrower
 * one.
 */
export function layerFn(
  layer: ContextLayer,
  name: string,
): (
  args: Record<string, unknown>,
  state: unknown,
  ctx: ExecutionContext,
) => Promise<{
  result: unknown;
  state?: unknown;
}> {
  const decl = layer.provides?.[name];
  if (decl === undefined || decl.kind !== 'function') {
    throw new Error(`layer does not expose a '${name}' function`);
  }
  return (args, state, ctx) => decl.execute(args, state, ctx);
}

//#endregion
