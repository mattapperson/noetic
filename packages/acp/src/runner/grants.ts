/**
 * What a runner with an allowlist lets a host start: a granted command with
 * its exact arguments, only the environment names that grant lists, in a
 * working directory inside the runner's own.
 *
 * Environment names are allowed rather than refused, since a launcher name
 * (`NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, …) runs code under any command, and
 * no list of such names is ever complete.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

//#region Types

/** @public A command a runner may start. */
export interface AcpRunnerGrant {
  command: string;
  args?: ReadonlyArray<string>;
  /** Environment names a host may set for it. It may set no others. */
  env?: ReadonlyArray<string>;
}

/** A start a host asked for. */
export interface Start {
  command: string;
  args: ReadonlyArray<string>;
  env: Record<string, string>;
  cwd?: string;
}

//#endregion

//#region Public API

/**
 * The real working directory for `start`, or a throw naming why the runner
 * refuses it. Without `allow` the host may start anything, anywhere.
 */
export function checkStart(
  start: Start,
  options: {
    allow?: ReadonlyArray<AcpRunnerGrant>;
    cwd?: string;
  },
): string {
  const root = options.cwd ?? process.cwd();
  if (!options.allow) {
    return existing(start.cwd ?? root);
  }
  const grant = options.allow.find(
    (entry) =>
      entry.command === start.command &&
      JSON.stringify(entry.args ?? []) === JSON.stringify(start.args),
  );
  if (!grant) {
    throw new Error(
      `This runner does not start '${[
        start.command,
        ...start.args,
      ].join(' ')}'.`,
    );
  }
  const granted = new Set(grant.env ?? []);
  const refused = Object.keys(start.env).filter((name) => !granted.has(name));
  if (refused.length > 0) {
    throw new Error(
      `This runner does not let a host set ${refused.join(', ')} for '${start.command}'.`,
    );
  }
  return inside(existing(root), existing(start.cwd ?? root));
}

//#endregion

//#region Helpers

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
