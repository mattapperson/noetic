/**
 * Types for the interactive startup binary-check flow.
 *
 * The flow probes a fixed set of binaries the CLI depends on (`rtk`,
 * `pilotty`, `agent-browser`) and resolves, per binary, one of three states:
 * already present, explicitly ignored by the user (persisted in
 * `~/.config/noetic/config.ts`), or missing-and-un-ignored (which triggers
 * the setup screen).
 */

import { z } from 'zod';

//#region BinaryId

export const BinaryIdSchema = z.enum([
  'rtk',
  'pilotty',
  'agent-browser',
]);

export type BinaryId = z.infer<typeof BinaryIdSchema>;

export const ALL_BINARY_IDS: ReadonlyArray<BinaryId> = [
  'rtk',
  'pilotty',
  'agent-browser',
];

export function isBinaryId(value: unknown): value is BinaryId {
  return BinaryIdSchema.safeParse(value).success;
}

//#endregion

//#region Binary status

export type BinaryState = 'present' | 'ignored' | 'missing';

export interface BinaryStatus {
  id: BinaryId;
  state: BinaryState;
}

/**
 * Post-setup map consumed by the harness: every binary is either present or
 * ignored. No `missing` — the setup flow always resolves ambiguity, either by
 * install success or by persisting an ignore.
 */
export type BinaryAvailability = ReadonlyMap<BinaryId, 'present' | 'ignored'>;

//#endregion

//#region OS + package managers

export type OsKind = 'macos' | 'linux' | 'windows' | 'other';

/** Detected package managers. Order in arrays is preference, highest first. */
export type PackageManager =
  | 'brew'
  | 'apt'
  | 'dnf'
  | 'pacman'
  | 'zypper'
  | 'cargo'
  | 'curl'
  | 'bun'
  | 'bunx'
  | 'winget'
  | 'scoop';

//#endregion

//#region Manifest shapes

/**
 * A single auto-install choice for one binary on one (os, pm) combination.
 * `requiresPackageManager` must be present in the detected list for the option
 * to render in the setup UI.
 */
export interface InstallOption {
  /** Short human label ("Homebrew", "cargo", "curl script"). */
  label: string;
  /** Command to exec — splits into argv. No shell interpolation. */
  command: string;
  args: ReadonlyArray<string>;
  /** If set, only render this option when the PM is detected. */
  requiresPackageManager?: PackageManager;
  /** Working directory for the spawn; defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Describes one binary and how to detect, install, and gate it.
 *
 * `kind: 'path'` — resolved via `Bun.which`. Standard PATH lookup.
 * `kind: 'workspace-dep'` — resolved via `require.resolve('pkg/package.json')`
 *   inside a child process (Bun caches require.resolve per-process; we need a
 *   fresh probe after an install step mutates node_modules).
 */
export interface BinaryDescriptor {
  id: BinaryId;
  displayName: string;
  summary: string;
  kind: 'path' | 'workspace-dep';
  /** Returns true if the binary is usable. */
  detect: () => Promise<boolean>;
  /** Ordered auto-install options for the detected (os, pms). */
  installOptionsFor: (os: OsKind, pms: ReadonlyArray<PackageManager>) => ReadonlyArray<InstallOption>;
  /** Multi-line manual instructions rendered in the manual waiter screen. */
  manualInstructionsFor: (os: OsKind) => string;
  /** Tools affected when this binary is missing-and-ignored. */
  affects: ReadonlyArray<{ toolId: 'interactive-terminal' | 'browser' | 'bash'; mode: 'omit' | 'degrade' }>;
}

//#endregion
