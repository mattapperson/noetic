/**
 * What a runner with an allowlist lets a host start: a granted command with
 * its exact arguments, only the environment names that grant lists, in a
 * working directory inside the runner's own.
 *
 * Environment names are allowed rather than refused, since a launcher name
 * (`NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, …) runs code under any command, and
 * no list of such names is ever complete. A value that names a command the
 * agent starts — a Codex config's MCP servers, pi's own command — is checked
 * against the grants or set by the runner itself.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';

//#region Types

/** @public A command a runner may start. */
export interface AcpRunnerGrant {
  command: string;
  args?: ReadonlyArray<string>;
  /** Environment names a host may set for it. It may set no others. */
  env?: ReadonlyArray<string>;
  /**
   * Environment the runner sets itself, over whatever a host sends under
   * these names: what the command would otherwise start on a host's word.
   */
  fixedEnv?: Readonly<Record<string, string>>;
}

/** A start a host asked for. */
export interface Start {
  command: string;
  args: ReadonlyArray<string>;
  env: Record<string, string>;
  cwd?: string;
}

/** What the runner starts a granted command with. */
export interface CheckedStart {
  /** The real working directory. */
  readonly cwd: string;
  /** The host's environment, with the grant's `fixedEnv` over it. */
  readonly env: Record<string, string>;
}

//#endregion

//#region Public API

/**
 * What the runner starts `start` with, or a throw naming why it refuses it.
 * Without `allow` the host may start anything, anywhere. With it, a
 * `CODEX_CONFIG` the host sets may declare only MCP server commands `allow`
 * grants, since Codex starts each one.
 */
export function checkStart(
  start: Start,
  options: {
    allow?: ReadonlyArray<AcpRunnerGrant>;
    cwd?: string;
  },
): CheckedStart {
  const root = options.cwd ?? process.cwd();
  const allow = options.allow;
  if (!allow) {
    return {
      cwd: existing(start.cwd ?? root),
      env: start.env,
    };
  }
  const grant = grantFor(allow, start.command, start.args);
  if (!grant) {
    throw new Error(`This runner does not start '${commandLine(start.command, start.args)}'.`);
  }
  const granted = new Set([
    ...(grant.env ?? []),
    ...Object.keys(grant.fixedEnv ?? {}),
  ]);
  const refused = Object.keys(start.env).filter((name) => !granted.has(name));
  if (refused.length > 0) {
    throw new Error(
      `This runner does not let a host set ${refused.join(', ')} for '${start.command}'.`,
    );
  }
  const codexConfig = start.env.CODEX_CONFIG;
  if (codexConfig !== undefined) {
    checkCodexConfig(codexConfig, allow);
  }
  return {
    cwd: inside(existing(root), existing(start.cwd ?? root)),
    env: {
      ...start.env,
      ...grant.fixedEnv,
    },
  };
}

//#endregion

//#region Helpers

const CodexServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const CodexConfigSchema = z.object({
  mcp_servers: z.record(z.string(), CodexServerSchema).optional(),
  notify: z.unknown().optional(),
});

/**
 * Codex starts every `mcp_servers` entry with a `command`, with its `env`, and
 * runs `notify` after each turn. Each server must be a granted command line
 * whose grant lists every name it sets; `notify` is refused outright.
 */
function checkCodexConfig(raw: string, allow: ReadonlyArray<AcpRunnerGrant>): void {
  const parsed = CodexConfigSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    throw new Error('This runner does not start Codex with a CODEX_CONFIG it cannot read.');
  }
  if (parsed.data.notify !== undefined) {
    throw new Error(
      'This runner does not let a host set CODEX_CONFIG.notify, a command Codex runs.',
    );
  }
  for (const [name, server] of Object.entries(parsed.data.mcp_servers ?? {})) {
    if (server.command === undefined) {
      continue;
    }
    const args = server.args ?? [];
    const grant = grantFor(allow, server.command, args);
    if (!grant) {
      throw new Error(
        `This runner does not start '${commandLine(server.command, args)}', which CODEX_CONFIG declares as MCP server '${name}'.`,
      );
    }
    const granted = new Set(grant.env ?? []);
    const refused = Object.keys(server.env ?? {}).filter((variable) => !granted.has(variable));
    if (refused.length > 0) {
      throw new Error(
        `This runner does not let a host set ${refused.join(', ')} for MCP server '${name}' in CODEX_CONFIG.`,
      );
    }
  }
}

function grantFor(
  allow: ReadonlyArray<AcpRunnerGrant>,
  command: string,
  args: ReadonlyArray<string>,
): AcpRunnerGrant | undefined {
  return allow.find(
    (entry) =>
      entry.command === command && JSON.stringify(entry.args ?? []) === JSON.stringify(args),
  );
}

function commandLine(command: string, args: ReadonlyArray<string>): string {
  return [
    command,
    ...args,
  ].join(' ');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The real path of `dir`, so a symlink cannot lead out of the runner's directory. */
function existing(dir: string): string {
  if (!existsSync(dir)) {
    throw new Error(`The working directory '${dir}' does not exist on the runner's machine.`);
  }
  return realpathSync(dir);
}

function inside(root: string, dir: string): string {
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`This runner starts nothing outside '${root}'; '${dir}' is.`);
  }
  return dir;
}

//#endregion
