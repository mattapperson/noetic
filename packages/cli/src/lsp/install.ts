/**
 * Resolve a LaunchSpec to a concrete `ResolvedCommand` that the service can
 * spawn. Three strategies dispatched through a handler registry:
 *
 *   - `path`           — locate a binary already on PATH, error with installHint if missing
 *   - `bunx`           — return a `bunx <bin> ...args` invocation (bun handles install)
 *   - `githubRelease`  — download the platform-appropriate asset from a GitHub release,
 *                        cache under ~/.noetic/lsp/<id>/<version>/, and resolve to the
 *                        cached binary. Gated by NOETIC_DISABLE_LSP_DOWNLOAD.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { BunxLaunchSpec, LaunchSpec, ResolvedCommand } from './types.js';

//#region Schemas

const GithubReleaseAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string(),
});

const GithubReleaseSchema = z.object({
  assets: z.array(GithubReleaseAssetSchema).optional(),
});

//#endregion

//#region Errors

export class LspInstallError extends Error {
  constructor(
    message: string,
    readonly serverId: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LspInstallError';
  }
}

//#endregion

//#region Handlers

type Resolver = (launch: LaunchSpec, serverId: string) => Promise<ResolvedCommand>;

async function resolveFromPath(launch: LaunchSpec, serverId: string): Promise<ResolvedCommand> {
  if (launch.strategy !== 'path') {
    throw new LspInstallError('resolveFromPath called with wrong strategy', serverId);
  }
  const found = await which(launch.bin);
  if (!found) {
    throw new LspInstallError(
      `Language server '${launch.bin}' not found on PATH for server '${serverId}'.`,
      serverId,
      launch.installHint,
    );
  }
  return {
    executable: found,
    args: launch.args,
  };
}

async function resolveViaBunx(launch: LaunchSpec, serverId: string): Promise<ResolvedCommand> {
  if (launch.strategy !== 'bunx') {
    throw new LspInstallError('resolveViaBunx called with wrong strategy', serverId);
  }
  // When peers are declared we must install them alongside the primary
  // package with real sibling `node_modules/` entries so the server can
  // resolve its peers via Node module lookup. `npm exec --package=<x>` only
  // exposes the primary package's own deps — not sibling `--package` installs
  // — which breaks `typescript-language-server`'s `require.resolve('typescript/...')`.
  // Install into a dedicated cache dir under ~/.noetic/lsp/ instead.
  if (launch.peers && launch.peers.length > 0) {
    return resolveViaSharedInstall(launch, serverId);
  }
  const bunxBin = (await which('bunx')) ?? (await which('npx'));
  if (!bunxBin) {
    throw new LspInstallError(
      `Neither 'bunx' nor 'npx' found on PATH — cannot launch server '${serverId}'.`,
      serverId,
      'Install Bun (https://bun.sh) or Node.js to get bunx/npx.',
    );
  }
  return {
    executable: bunxBin,
    args: [
      launch.bin,
      ...launch.args,
    ],
  };
}

/**
 * Install the primary package + peers as siblings in a dedicated cache
 * directory, then spawn the bin from there. `npm exec --package=<x> --package=<y>`
 * only exposes the primary package's own deps to the running bin, so peer
 * packages aren't resolvable via Node module lookup under that mode. A real
 * sibling `node_modules/` layout fixes it — `typescript-language-server` finds
 * `typescript` at `../typescript/lib/tsserver.js` as expected.
 */
async function resolveViaSharedInstall(
  launch: BunxLaunchSpec,
  serverId: string,
): Promise<ResolvedCommand> {
  if (!launch.peers || launch.peers.length === 0) {
    throw new LspInstallError('resolveViaSharedInstall called without peer packages', serverId);
  }
  if (process.env.NOETIC_DISABLE_LSP_DOWNLOAD === '1') {
    throw new LspInstallError(
      `LSP auto-install is disabled (NOETIC_DISABLE_LSP_DOWNLOAD=1), cannot install '${launch.pkg}' + peers for server '${serverId}'.`,
      serverId,
    );
  }
  const safeServerId = assertSafePathComponent(serverId, 'serverId', serverId);
  const installDir = join(homedir(), '.noetic', 'lsp', `${safeServerId}-peered`);
  await ensureSharedInstall({
    dir: installDir,
    pkg: launch.pkg,
    peers: launch.peers,
    serverId,
  });
  const binSuffix = process.platform === 'win32' ? '.cmd' : '';
  const binPath = join(installDir, 'node_modules', '.bin', `${launch.bin}${binSuffix}`);
  if (!existsSync(binPath)) {
    throw new LspInstallError(
      `LSP bin '${launch.bin}' not found at ${binPath} after install — check that '${launch.pkg}' exposes this binary.`,
      serverId,
    );
  }
  return {
    executable: binPath,
    args: [
      ...launch.args,
    ],
  };
}

interface SharedInstallRequest {
  dir: string;
  pkg: string;
  peers: ReadonlyArray<string>;
  serverId: string;
}

/**
 * Ensure `dir` has a `package.json` listing `pkg` + all `peers` as deps and a
 * matching `node_modules/` tree. Idempotent: re-reads the manifest and skips
 * `npm install` when the dep set is unchanged and the primary package is
 * already on disk.
 */
async function ensureSharedInstall(req: SharedInstallRequest): Promise<void> {
  const manifestPath = join(req.dir, 'package.json');
  const desired = buildInstallManifest(req.pkg, req.peers);
  if (
    await installIsFresh({
      manifestPath,
      desired,
      installDir: req.dir,
      pkg: req.pkg,
    })
  ) {
    return;
  }
  const npmBin = await which('npm');
  if (!npmBin) {
    throw new LspInstallError(
      `'npm' not found on PATH — cannot install peer packages for server '${req.serverId}'.`,
      req.serverId,
      'Install Node.js to get `npm`, which is required when a language server declares peer packages.',
    );
  }
  await mkdir(req.dir, {
    recursive: true,
  });
  await writeFile(manifestPath, `${desired}\n`, 'utf8');
  await runNpmInstall(npmBin, req.dir, req.serverId);
}

function buildInstallManifest(pkg: string, peers: ReadonlyArray<string>): string {
  const dependencies: Record<string, string> = {
    [pkg]: 'latest',
  };
  for (const peer of peers) {
    dependencies[peer] = 'latest';
  }
  return JSON.stringify(
    {
      name: 'noetic-lsp-install',
      private: true,
      dependencies,
    },
    null,
    2,
  );
}

interface FreshnessCheck {
  manifestPath: string;
  desired: string;
  installDir: string;
  pkg: string;
}

async function installIsFresh(check: FreshnessCheck): Promise<boolean> {
  let existing: string;
  try {
    existing = await readFile(check.manifestPath, 'utf8');
  } catch {
    return false;
  }
  if (existing.trimEnd() !== check.desired) {
    return false;
  }
  return existsSync(join(check.installDir, 'node_modules', check.pkg));
}

async function runNpmInstall(npmBin: string, cwd: string, serverId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      npmBin,
      [
        'install',
        '--silent',
        '--no-audit',
        '--no-fund',
        '--no-progress',
      ],
      {
        cwd,
        stdio: [
          'ignore',
          'ignore',
          'pipe',
        ],
      },
    );
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new LspInstallError(
          `npm install for server '${serverId}' failed (exit ${code}): ${stderr.trim()}`,
          serverId,
        ),
      );
    });
  });
}

async function resolveViaGithubRelease(
  launch: LaunchSpec,
  serverId: string,
): Promise<ResolvedCommand> {
  if (launch.strategy !== 'githubRelease') {
    throw new LspInstallError('resolveViaGithubRelease called with wrong strategy', serverId);
  }
  if (process.env.NOETIC_DISABLE_LSP_DOWNLOAD === '1') {
    throw new LspInstallError(
      `LSP auto-download is disabled (NOETIC_DISABLE_LSP_DOWNLOAD=1), cannot fetch server '${serverId}'.`,
      serverId,
    );
  }
  const safeServerId = assertSafePathComponent(serverId, 'serverId', serverId);
  const safeVersion = assertSafePathComponent(launch.version ?? 'latest', 'version', serverId);
  const safeAssetName = assertSafePathComponent(
    launch.asset(process.platform, process.arch),
    'assetName',
    serverId,
  );
  const cacheDir = join(homedir(), '.noetic', 'lsp', safeServerId, safeVersion);
  const cachedPath = join(cacheDir, safeAssetName);
  if (existsSync(cachedPath)) {
    return {
      executable: cachedPath,
      args: launch.args,
    };
  }
  await downloadReleaseAsset({
    owner: launch.owner,
    repo: launch.repo,
    version: safeVersion,
    assetName: safeAssetName,
    destination: cachedPath,
    serverId,
  });
  return {
    executable: cachedPath,
    args: launch.args,
  };
}

const resolvers: Record<LaunchSpec['strategy'], Resolver> = {
  path: resolveFromPath,
  bunx: resolveViaBunx,
  githubRelease: resolveViaGithubRelease,
};

//#endregion

//#region Helpers

async function which(bin: string): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  return new Promise((resolve) => {
    const proc = spawn(
      cmd,
      [
        bin,
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
      },
    );
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const firstLine = stdout.split(/\r?\n/)[0]?.trim();
      resolve(firstLine && firstLine.length > 0 ? firstLine : null);
    });
    proc.on('error', () => resolve(null));
  });
}

interface DownloadRequest {
  owner: string;
  repo: string;
  version: string;
  assetName: string;
  destination: string;
  serverId: string;
}

const TRUSTED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
]);

function assertTrustedDownloadUrl(url: string, serverId: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LspInstallError(`Release asset URL is not a valid URL: ${url}`, serverId);
  }
  if (parsed.protocol !== 'https:') {
    throw new LspInstallError(
      `Release asset URL must use https (got ${parsed.protocol}): ${url}`,
      serverId,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const isTrusted =
    TRUSTED_DOWNLOAD_HOSTS.has(host) ||
    host.endsWith('.githubusercontent.com') ||
    host.endsWith('.github.com');
  if (!isTrusted) {
    throw new LspInstallError(
      `Release asset URL host '${host}' is not on the trusted download allowlist`,
      serverId,
    );
  }
  return parsed;
}

/**
 * Reject path components that would escape the cache directory. Plugins
 * control `assetName`, `version`, and (indirectly) `serverId`, so each must
 * be a simple filename — no separators, no `..`, no leading dot (prevents
 * clobbering dotfiles like `.bashrc` in the cache).
 */
function assertSafePathComponent(value: string, field: string, serverId: string): string {
  if (value.length === 0) {
    throw new LspInstallError(`Launch spec '${field}' must not be empty`, serverId);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new LspInstallError(
      `Launch spec '${field}' must not contain path separators: ${value}`,
      serverId,
    );
  }
  if (value === '.' || value === '..' || value.startsWith('.')) {
    throw new LspInstallError(
      `Launch spec '${field}' must not start with '.' or be a relative segment: ${value}`,
      serverId,
    );
  }
  return value;
}

async function downloadReleaseAsset(req: DownloadRequest): Promise<void> {
  const releaseUrl =
    req.version === 'latest'
      ? `https://api.github.com/repos/${req.owner}/${req.repo}/releases/latest`
      : `https://api.github.com/repos/${req.owner}/${req.repo}/releases/tags/${req.version}`;
  const releaseRes = await fetch(releaseUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'noetic-cli',
    },
  });
  if (!releaseRes.ok) {
    throw new LspInstallError(
      `Failed to fetch GitHub release metadata (${releaseRes.status})`,
      req.serverId,
    );
  }
  const parsed = GithubReleaseSchema.safeParse(await releaseRes.json());
  if (!parsed.success) {
    throw new LspInstallError(
      `GitHub release metadata for ${req.owner}/${req.repo} did not match expected shape`,
      req.serverId,
    );
  }
  const downloadUrl = findAssetUrl(parsed.data.assets ?? [], req.assetName);
  if (!downloadUrl) {
    throw new LspInstallError(`Release asset '${req.assetName}' not found`, req.serverId);
  }
  assertTrustedDownloadUrl(downloadUrl, req.serverId);
  await mkdir(dirname(req.destination), {
    recursive: true,
  });
  const tmpPath = `${req.destination}.part`;
  const assetRes = await fetch(downloadUrl, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'noetic-cli',
    },
  });
  if (!assetRes.ok || !assetRes.body) {
    throw new LspInstallError(
      `Failed to download asset '${req.assetName}' (${assetRes.status})`,
      req.serverId,
    );
  }
  const expectedSize = parseContentLength(assetRes.headers.get('content-length'));
  try {
    const bytesWritten = await writeWebStreamToFile(assetRes.body, tmpPath);
    if (expectedSize !== null && bytesWritten !== expectedSize) {
      throw new LspInstallError(
        `Download size mismatch for '${req.assetName}' — expected ${expectedSize} bytes, got ${bytesWritten}`,
        req.serverId,
      );
    }
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, req.destination);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function parseContentLength(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const n = Number.parseInt(header, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function writeWebStreamToFile(
  body: ReadableStream<Uint8Array>,
  destination: string,
): Promise<number> {
  const out = createWriteStream(destination);
  const reader = body.getReader();
  let bytesWritten = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      bytesWritten += value.byteLength;
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      }
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolve, reject) => {
      out.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
    });
  }
  return bytesWritten;
}

type GithubReleaseAsset = z.infer<typeof GithubReleaseAssetSchema>;

function findAssetUrl(assets: ReadonlyArray<GithubReleaseAsset>, assetName: string): string | null {
  for (const asset of assets) {
    if (asset.name === assetName) {
      return asset.browser_download_url;
    }
  }
  return null;
}

//#endregion

//#region Public API

/**
 * Resolve a LaunchSpec to a spawnable `ResolvedCommand`. Throws
 * `LspInstallError` with an install hint if the binary can't be located.
 */
export async function resolveLaunchCommand(
  launch: LaunchSpec,
  serverId: string,
): Promise<ResolvedCommand> {
  const resolver = resolvers[launch.strategy];
  if (!resolver) {
    throw new LspInstallError(`Unknown launch strategy '${launch.strategy}'`, serverId);
  }
  return resolver(launch, serverId);
}

//#endregion
