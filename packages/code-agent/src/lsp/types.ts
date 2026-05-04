/**
 * LSP server contribution types. These are the stable surface plugin authors
 * import to register additional language servers via `NoeticPlugin.lspServers`.
 */

//#region Launch strategies

/**
 * Locate a binary already on the user's PATH. Use for language servers
 * that are distributed outside npm (go, swift, rust, etc.) and typically
 * installed via a toolchain manager.
 */
export interface PathLaunchSpec {
  strategy: 'path';
  bin: string;
  args: ReadonlyArray<string>;
  /** Shown to the user if the binary isn't found, e.g. an `install` command. */
  installHint?: string;
}

/**
 * Launch via `bunx <bin>` or `npm exec --package=<pkg> ... -- <bin>`.
 * Appropriate for npm-distributed servers (typescript-language-server, pyright).
 * Zero-install for the user.
 *
 * If `peers` is declared, the runner installs the primary package alongside
 * each peer in the same ephemeral install so the server can resolve its peer
 * dependencies at runtime. `typescript-language-server`, for example, needs
 * `typescript` to be installed beside it — without that, initialize fails with
 * "Could not find a valid TypeScript installation."
 */
export interface BunxLaunchSpec {
  strategy: 'bunx';
  /** npm package that provides the bin. */
  pkg: string;
  /** Binary name exposed by the package. Often equal to `pkg`. */
  bin: string;
  args: ReadonlyArray<string>;
  /**
   * Additional packages to install alongside `pkg`. Servers like
   * `typescript-language-server` rely on `typescript` being resolvable via
   * Node module lookup; listing it here guarantees co-installation. When
   * present, the runner uses `npm exec` (the only robust multi-package runner).
   */
  peers?: ReadonlyArray<string>;
}

/**
 * Download a prebuilt binary from a GitHub release on first use and cache it
 * under `~/.noetic/lsp/<id>/<version>/`. Gated by `NOETIC_DISABLE_LSP_DOWNLOAD=1`.
 */
export interface GithubReleaseLaunchSpec {
  strategy: 'githubRelease';
  owner: string;
  repo: string;
  /** Pick the correct release asset name for the running OS/arch. */
  asset: (platform: NodeJS.Platform, arch: string) => string;
  /** Pin a tag, or omit for `latest`. */
  version?: string;
  /** Args passed when spawning the downloaded binary. */
  args: ReadonlyArray<string>;
}

export type LaunchSpec = PathLaunchSpec | BunxLaunchSpec | GithubReleaseLaunchSpec;

export const LaunchStrategy = {
  Path: 'path',
  Bunx: 'bunx',
  GithubRelease: 'githubRelease',
} as const;

export type LaunchStrategy = (typeof LaunchStrategy)[keyof typeof LaunchStrategy];

//#endregion

//#region Contribution

/**
 * A language server contribution. Built-in contributions live in
 * `packages/cli/src/lsp/builtin/` and plugin contributions come through the
 * `lspServers` hook on `NoeticPlugin`. Contributions are aggregated once per
 * harness construction into an `ExtensionIndex`.
 */
export interface LspServerContribution {
  /**
   * Unique id (e.g. `'typescript'`, `'rust-analyzer'`). Used as the dedup key
   * across builtins + plugins — a plugin contribution with the same id as a
   * builtin overrides the builtin.
   */
  id: string;
  /** File extensions this server handles. Lowercase, leading dot. */
  extensions: ReadonlyArray<string>;
  /**
   * Workspace-root markers. The root resolver walks up from a file until it
   * finds a directory containing one of these.
   */
  rootMarkers: ReadonlyArray<string>;
  /** How to locate or install the server binary. */
  launch: LaunchSpec;
  /** Optional `initializationOptions` passed in the LSP `initialize` request. */
  initializationOptions?: unknown;
}

//#endregion

//#region Resolved command (internal)

/**
 * The concrete command the installer resolved for a given contribution.
 * Returned by `install.ts` — `executable` is absolute-path-or-resolvable,
 * `args` is the full argv.
 */
export interface ResolvedCommand {
  executable: string;
  args: ReadonlyArray<string>;
}

//#endregion
