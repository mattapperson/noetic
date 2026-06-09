import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLocalFsAdapter } from '@noetic-tools/platform-node';

import type { LspClientApi } from '../src/lsp/client.js';
import { LspService } from '../src/lsp/service.js';
import type { LspServerContribution } from '../src/lsp/types.js';

interface FakeClientState {
  startCount: number;
  shutdownCount: number;
  openedUris: string[];
}

function createFakeClient(opts: {
  id: string;
  root: string;
  state: FakeClientState;
  failStart?: boolean;
}): LspClientApi {
  const client: LspClientApi = {
    id: opts.id,
    root: opts.root,
    async start() {
      if (opts.failStart) {
        throw new Error('simulated start failure');
      }
      opts.state.startCount += 1;
    },
    async shutdown() {
      opts.state.shutdownCount += 1;
    },
    async openOrUpdate(uri: string) {
      opts.state.openedUris.push(uri);
    },
    async close() {},
    isOpen() {
      return true;
    },
    async hover() {
      return null;
    },
    async definition() {
      return null;
    },
    async references() {
      return null;
    },
    async implementation() {
      return null;
    },
    async documentSymbol() {
      return null;
    },
    async workspaceSymbol() {
      return null;
    },
    async prepareCallHierarchy() {
      return null;
    },
    async incomingCalls() {
      return null;
    },
    async outgoingCalls() {
      return null;
    },
    async pullDiagnostics() {
      return [];
    },
  };
  return client;
}

const fs = createLocalFsAdapter();

function tsContribution(): LspServerContribution {
  return {
    id: 'typescript',
    extensions: [
      '.ts',
    ],
    rootMarkers: [
      'package.json',
    ],
    launch: {
      strategy: 'path',
      bin: 'does-not-exist',
      args: [],
    },
  };
}

describe('LspService', () => {
  let root: string;
  let tsFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'noetic-lsp-svc-'));
    await writeFile(join(root, 'package.json'), '{}', 'utf8');
    await mkdir(join(root, 'src'), {
      recursive: true,
    });
    tsFile = join(root, 'src', 'entry.ts');
    await writeFile(tsFile, 'export const x = 1;\n', 'utf8');
  });

  afterAll(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it('touchFile returns null when no contribution matches the extension', async () => {
    const service = new LspService({
      servers: [
        tsContribution(),
      ],
      cwd: root,
      fs,
    });
    const result = await service.touchFile(join(root, 'README.md'));
    expect(result).toBeNull();
    await service.dispose();
  });

  it('touchFile spawns a client once and reuses it for subsequent calls', async () => {
    const state: FakeClientState = {
      startCount: 0,
      shutdownCount: 0,
      openedUris: [],
    };
    const service = new LspService({
      servers: [
        tsContribution(),
      ],
      cwd: root,
      fs,
      clientFactory: ({ contribution, root: cRoot }) =>
        createFakeClient({
          id: contribution.id,
          root: cRoot,
          state,
        }),
    });

    const first = await service.touchFile(tsFile);
    const second = await service.touchFile(tsFile);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.handle.client).toBe(second?.handle.client);
    expect(state.startCount).toBe(1);
    expect(state.openedUris.length).toBe(2);
    expect(first?.uri).toBe(pathToFileURL(tsFile).href);
    expect(service.hasClient('typescript', root)).toBe(true);

    await service.dispose();
    expect(state.shutdownCount).toBe(1);
  });

  it('concurrent touchFile calls dedupe the in-flight initialize', async () => {
    const state: FakeClientState = {
      startCount: 0,
      shutdownCount: 0,
      openedUris: [],
    };
    const service = new LspService({
      servers: [
        tsContribution(),
      ],
      cwd: root,
      fs,
      clientFactory: ({ contribution, root: cRoot }) =>
        createFakeClient({
          id: contribution.id,
          root: cRoot,
          state,
        }),
    });

    const [a, b, c] = await Promise.all([
      service.touchFile(tsFile),
      service.touchFile(tsFile),
      service.touchFile(tsFile),
    ]);
    expect(state.startCount).toBe(1);
    expect(a?.handle.client).toBe(b?.handle.client);
    expect(b?.handle.client).toBe(c?.handle.client);
    await service.dispose();
  });

  it('marks a server broken after a failed start and returns null on retry', async () => {
    const state: FakeClientState = {
      startCount: 0,
      shutdownCount: 0,
      openedUris: [],
    };
    const service = new LspService({
      servers: [
        tsContribution(),
      ],
      cwd: root,
      fs,
      clientFactory: ({ contribution, root: cRoot }) =>
        createFakeClient({
          id: contribution.id,
          root: cRoot,
          state,
          failStart: true,
        }),
    });
    const first = await service.touchFile(tsFile);
    expect(first).toBeNull();
    // Second call should return null without attempting to start again.
    const before = state.startCount;
    const second = await service.touchFile(tsFile);
    expect(second).toBeNull();
    expect(state.startCount).toBe(before);
    await service.dispose();
  });

  it('dispose shuts down all ready clients', async () => {
    const state: FakeClientState = {
      startCount: 0,
      shutdownCount: 0,
      openedUris: [],
    };
    const service = new LspService({
      servers: [
        tsContribution(),
      ],
      cwd: root,
      fs,
      clientFactory: ({ contribution, root: cRoot }) =>
        createFakeClient({
          id: contribution.id,
          root: cRoot,
          state,
        }),
    });
    await service.touchFile(tsFile);
    expect(state.shutdownCount).toBe(0);
    await service.dispose();
    expect(state.shutdownCount).toBe(1);
    // touchFile after dispose returns null
    const after = await service.touchFile(tsFile);
    expect(after).toBeNull();
  });

  it('dispose fired mid-start shuts down the resolving client rather than leaking it', async () => {
    const state: FakeClientState = {
      startCount: 0,
      shutdownCount: 0,
      openedUris: [],
    };
    let releaseStart: () => void = () => {};
    const startBlocker = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const service = new LspService({
      servers: [
        tsContribution(),
      ],
      cwd: root,
      fs,
      clientFactory: ({ contribution, root: cRoot }) => {
        const base = createFakeClient({
          id: contribution.id,
          root: cRoot,
          state,
        });
        // Override start() to block until we release it, simulating a slow
        // initialize that still completes AFTER dispose() has run.
        return {
          ...base,
          async start() {
            await startBlocker;
            state.startCount += 1;
          },
        };
      },
    });

    const touchPromise = service.touchFile(tsFile);
    // Let dispose run first; the in-flight start is still blocked.
    const disposePromise = service.dispose();
    // Now release the blocked start; it resolves AFTER dispose cleared state.
    releaseStart?.();
    const [touchResult] = await Promise.all([
      touchPromise,
      disposePromise,
    ]);

    expect(touchResult).toBeNull();
    // The client that resolved post-dispose must have been shut down.
    expect(state.shutdownCount).toBe(1);
    expect(service.hasClient('typescript', root)).toBe(false);
  });
});
