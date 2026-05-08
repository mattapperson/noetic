/**
 * Binary detectors.
 *
 * Two kinds:
 *   - `path` binaries resolve via `Bun.which` (standard PATH lookup).
 *   - `workspace-dep` binaries resolve via `require.resolve(pkg/package.json)`
 *     anchored to THIS module's URL so the resolution runs inside the CLI
 *     package's module graph (where pilotty and agent-browser live as
 *     workspace deps). An anchor-less resolve (or a naive `bun -e` in a child
 *     process spawned from the repo root) would miss them because the repo
 *     root has no direct dep on either package.
 *
 *     After an install step mutates node_modules, `require.resolve` may still
 *     cache the prior miss within this process. The post-install probe uses a
 *     fresh child process whose cwd points at the CLI package directory to
 *     bypass that cache.
 *
 * For `agent-browser` we additionally run the shim with `--version` on a
 * short timeout, because the package ships a launcher that downloads Chrome
 * on postinstall — the shim can exist while Chrome doesn't.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { BinaryId } from './types.js';

//#region Anchoring

const requireFromHere = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPackageJson(url: URL): Record<string, unknown> | null {
  try {
    const raw = requireFromHere(fileURLToPath(url));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The CLI package root (`packages/cli`). We walk up from THIS module's URL
 * until we find a `package.json` with `"name": "@noetic/cli"`. Child-process
 * probes spawn from here so they resolve against the CLI's node_modules
 * (pilotty, agent-browser live there as workspace deps).
 */
function findCliPackageRoot(): string {
  let current = new URL('.', import.meta.url);
  while (true) {
    const pkgUrl = new URL('package.json', current);
    const pkg = readPackageJson(pkgUrl);
    if (pkg !== null && pkg.name === '@noetic/cli') {
      return fileURLToPath(current);
    }
    const parentUrl = new URL('..', current);
    if (parentUrl.pathname === current.pathname) {
      break;
    }
    current = parentUrl;
  }
  // Fall back to two levels above this file (src/setup/ → src/ → packages/cli/).
  return fileURLToPath(new URL('../..', import.meta.url));
}

const CLI_PACKAGE_ROOT = findCliPackageRoot();

//#endregion

//#region Path-kind detection (rtk)

export function detectRtk(path: string = process.env.PATH ?? ''): boolean {
  return (
    Bun.which('rtk', {
      PATH: path,
    }) !== null
  );
}

//#endregion

//#region Workspace-dep detection

/**
 * In-process resolve anchored at the detector module. This is the fast path
 * and works for the common case where the dep was installed before the CLI
 * booted.
 */
function resolveWorkspaceDep(pkg: string): string | null {
  try {
    return requireFromHere.resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
}

/**
 * Fresh child-process resolve rooted at the CLI package dir. Used only when
 * the in-process cache might have a stale miss (e.g. just after the user ran
 * `bun install` via the auto-install path).
 */
async function probeWorkspaceDepFresh(pkg: string): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      `try { process.stdout.write(require.resolve(${JSON.stringify(`${pkg}/package.json`)})); } catch { process.exit(1); }`,
    ],
    cwd: CLI_PACKAGE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return null;
  }
  const resolved = (await new Response(proc.stdout).text()).trim();
  return resolved.length > 0 ? resolved : null;
}

async function resolveWorkspaceDepWithFallback(pkg: string): Promise<string | null> {
  const inProcess = resolveWorkspaceDep(pkg);
  if (inProcess !== null) {
    return inProcess;
  }
  return probeWorkspaceDepFresh(pkg);
}

export async function detectPilotty(): Promise<boolean> {
  return (await resolveWorkspaceDepWithFallback('pilotty')) !== null;
}

/**
 * agent-browser needs both the shim (`require.resolve` succeeds) AND a
 * working `--version` invocation — the package downloads Chrome on
 * postinstall, and if that step failed, the shim is present but the
 * binary will error the first time the browser tool fires.
 *
 * A failed `--version` here is the signal to offer `bunx agent-browser install`
 * as the next auto-install step.
 */
export async function detectAgentBrowser(): Promise<boolean> {
  const pkgJson = await resolveWorkspaceDepWithFallback('agent-browser');
  if (pkgJson === null) {
    return false;
  }

  const binPath = pkgJson.replace(/package\.json$/, 'bin/agent-browser.js');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);

  try {
    const proc = Bun.spawn({
      cmd: [
        binPath,
        '--version',
      ],
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

//#endregion

//#region Dispatch

export async function detectBinary(id: BinaryId): Promise<boolean> {
  if (id === 'rtk') {
    return detectRtk();
  }
  if (id === 'pilotty') {
    return detectPilotty();
  }
  return detectAgentBrowser();
}

//#endregion
