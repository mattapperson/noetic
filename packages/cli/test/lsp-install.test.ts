import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { LspInstallError, resolveLaunchCommand } from '../src/lsp/install.js';
import type { LaunchSpec } from '../src/lsp/types.js';

describe('resolveLaunchCommand — path strategy', () => {
  it('throws with install hint when bin is missing from PATH', async () => {
    const launch: LaunchSpec = {
      strategy: 'path',
      bin: 'definitely-not-on-path-noetic-xyz',
      args: [],
      installHint: 'install it somehow',
    };
    try {
      await resolveLaunchCommand(launch, 'server-x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.serverId).toBe('server-x');
      expect(err.hint).toBe('install it somehow');
      expect(err.message).toContain('definitely-not-on-path-noetic-xyz');
    }
  });
});

describe('resolveLaunchCommand — bunx strategy', () => {
  it('resolves to bunx/npx plus the bin name as first arg when no peers', async () => {
    // This test assumes at least one of bunx/npx is on PATH — both are
    // installed in the dev environment. Skip otherwise.
    const launch: LaunchSpec = {
      strategy: 'bunx',
      pkg: 'typescript-language-server',
      bin: 'typescript-language-server',
      args: [
        '--stdio',
      ],
    };
    const result = await resolveLaunchCommand(launch, 'typescript');
    expect(result.executable.length).toBeGreaterThan(0);
    expect(result.args[0]).toBe('typescript-language-server');
    expect(result.args[1]).toBe('--stdio');
  });

  it('routes peers through the shared-install path (gated by the disable flag)', async () => {
    // Setting NOETIC_DISABLE_LSP_DOWNLOAD proves we took the shared-install
    // branch without actually running `npm install` in the test. The non-peer
    // branch above ignores this flag, so this is a reliable routing signal.
    const previous = process.env.NOETIC_DISABLE_LSP_DOWNLOAD;
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = '1';
    try {
      const launch: LaunchSpec = {
        strategy: 'bunx',
        pkg: 'typescript-language-server',
        bin: 'typescript-language-server',
        args: [
          '--stdio',
        ],
        peers: [
          'typescript',
        ],
      };
      await resolveLaunchCommand(launch, 'typescript');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.message).toContain('NOETIC_DISABLE_LSP_DOWNLOAD');
      expect(err.message).toContain('peers');
    } finally {
      if (previous === undefined) {
        delete process.env.NOETIC_DISABLE_LSP_DOWNLOAD;
      } else {
        process.env.NOETIC_DISABLE_LSP_DOWNLOAD = previous;
      }
    }
  });

  it('rejects unsafe serverId when routing through shared install', async () => {
    const previous = process.env.NOETIC_DISABLE_LSP_DOWNLOAD;
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = '';
    try {
      const launch: LaunchSpec = {
        strategy: 'bunx',
        pkg: 'some-server',
        bin: 'some-server',
        args: [],
        peers: [
          'peer-a',
        ],
      };
      await resolveLaunchCommand(launch, '../evil');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.message).toContain('serverId');
    } finally {
      if (previous === undefined) {
        delete process.env.NOETIC_DISABLE_LSP_DOWNLOAD;
      } else {
        process.env.NOETIC_DISABLE_LSP_DOWNLOAD = previous;
      }
    }
  });
});

describe('resolveLaunchCommand — githubRelease strategy', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.NOETIC_DISABLE_LSP_DOWNLOAD;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.NOETIC_DISABLE_LSP_DOWNLOAD;
      return;
    }
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = previous;
  });

  function baseSpec(overrides?: { assetName?: string; version?: string }): LaunchSpec {
    return {
      strategy: 'githubRelease',
      owner: 'example',
      repo: 'srv',
      version: overrides?.version ?? '1.0.0',
      asset: () => overrides?.assetName ?? 'srv-linux-x64',
      args: [],
    };
  }

  it('throws when auto-download is disabled via env flag', async () => {
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = '1';
    try {
      await resolveLaunchCommand(baseSpec(), 'srv');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.message).toContain('NOETIC_DISABLE_LSP_DOWNLOAD');
      expect(err.serverId).toBe('srv');
    }
  });

  it('rejects assetName containing a path separator', async () => {
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = '';
    try {
      await resolveLaunchCommand(
        baseSpec({
          assetName: '../../etc/passwd',
        }),
        'srv',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.message).toContain('assetName');
    }
  });

  it('rejects assetName with a leading dot (dotfile)', async () => {
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = '';
    try {
      await resolveLaunchCommand(
        baseSpec({
          assetName: '.bashrc',
        }),
        'srv',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.message).toContain("must not start with '.'");
    }
  });

  it('rejects version containing a path separator', async () => {
    process.env.NOETIC_DISABLE_LSP_DOWNLOAD = '';
    try {
      await resolveLaunchCommand(
        baseSpec({
          version: '1.0/evil',
        }),
        'srv',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LspInstallError);
      if (!(err instanceof LspInstallError)) {
        throw err;
      }
      expect(err.message).toContain('version');
    }
  });
});

describe('LspInstallError', () => {
  it('stores serverId and hint on the instance', () => {
    const err = new LspInstallError('boom', 'svc', 'try xyz');
    expect(err.name).toBe('LspInstallError');
    expect(err.serverId).toBe('svc');
    expect(err.hint).toBe('try xyz');
  });

  it('stores serverId without hint when none provided', () => {
    const err = new LspInstallError('boom', 'svc');
    expect(err.hint).toBeUndefined();
  });
});
