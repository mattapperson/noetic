/**
 * LspService — the object tools hold onto. Given an ExtensionIndex (builtin +
 * plugin contributions) and a workspace cwd, it lazily spawns `LspClient`s,
 * keeps them keyed by `(id, root)`, and routes operation calls to the right
 * client. Owns the `DiagnosticStore`.
 */

import { pathToFileURL } from 'node:url';

import type { FsAdapter } from '@noetic/core';
import type { Diagnostic } from 'vscode-languageserver-protocol';

import type { LspClientApi } from './client.js';
import { LspClient } from './client.js';
import { DiagnosticStore } from './diagnostics.js';
import type { ExtensionIndex } from './extension-index.js';
import { createExtensionIndex, resolveContributionForFile } from './extension-index.js';
import { LspInstallError, resolveLaunchCommand } from './install.js';
import { findNearestRoot } from './root-resolver.js';
import type { LspServerContribution } from './types.js';

//#region Types

export interface LspServiceOptions {
  servers: ReadonlyArray<LspServerContribution>;
  cwd: string;
  fs: FsAdapter;
  /** If set, the service uses this factory instead of spawning a real client. For tests. */
  clientFactory?: (args: ClientFactoryArgs) => LspClientApi;
}

export interface ClientFactoryArgs {
  contribution: LspServerContribution;
  root: string;
  onPublishDiagnostics: (uri: string, diagnostics: ReadonlyArray<Diagnostic>) => void;
}

export interface ClientHandle {
  client: LspClientApi;
  contribution: LspServerContribution;
  root: string;
}

export interface TouchFileResult {
  handle: ClientHandle;
  uri: string;
  /** The file contents the client was synchronized to. Useful for text-level fallbacks. */
  text: string;
}

//#endregion

//#region LspService

export class LspService {
  readonly diagnostics = new DiagnosticStore();
  private readonly index: ExtensionIndex;
  private readonly cwd: string;
  private readonly fs: FsAdapter;
  private readonly clientFactory?: (args: ClientFactoryArgs) => LspClientApi;
  private readonly pending = new Map<string, Promise<ClientHandle>>();
  private readonly ready = new Map<string, ClientHandle>();
  private readonly broken = new Set<string>();
  private disposed = false;

  constructor(opts: LspServiceOptions) {
    this.index = createExtensionIndex(opts.servers);
    this.cwd = opts.cwd;
    this.fs = opts.fs;
    this.clientFactory = opts.clientFactory;
  }

  /**
   * Prepare a client for the given file: resolve the contribution, find the
   * workspace root, spawn+initialize the client if needed, send didOpen or
   * didChange with the current file contents. Returns the handle + URI for
   * subsequent LSP operations. Returns null if no contribution handles the
   * file extension.
   */
  async touchFile(absolutePath: string): Promise<TouchFileResult | null> {
    if (this.disposed) {
      return null;
    }
    const contribution = resolveContributionForFile(this.index, absolutePath);
    if (!contribution) {
      return null;
    }
    const root =
      (await findNearestRoot(this.fs, absolutePath, contribution.rootMarkers)) ?? this.cwd;
    const handle = await this.getOrCreateClient(contribution, root);
    if (!handle) {
      return null;
    }
    const buffer = await this.fs.readFile(absolutePath);
    const text = buffer.toString('utf-8');
    const uri = pathToFileURL(absolutePath).href;
    const languageId = contribution.id;
    await handle.client.openOrUpdate(uri, languageId, text);
    return {
      handle,
      uri,
      text,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.diagnostics.clearAll();
    const handles = Array.from(this.ready.values());
    this.ready.clear();
    this.pending.clear();
    await Promise.allSettled(handles.map((h) => h.client.shutdown()));
  }

  /** @internal — for tests and diagnostics */
  hasClient(id: string, root: string): boolean {
    return this.ready.has(clientKey(id, root));
  }

  private async getOrCreateClient(
    contribution: LspServerContribution,
    root: string,
  ): Promise<ClientHandle | null> {
    const key = clientKey(contribution.id, root);
    if (this.broken.has(key)) {
      return null;
    }
    const existing = this.ready.get(key);
    if (existing) {
      return existing;
    }
    const inflight = this.pending.get(key);
    if (inflight) {
      return inflight;
    }
    const starting = this.spawnClient(contribution, root);
    this.pending.set(key, starting);
    try {
      const handle = await starting;
      // Guard against dispose firing mid-start: without this, a handle
      // resolved after `dispose()` cleared `ready` would reach `ready.set`
      // and leak its subprocess.
      if (this.disposed) {
        await handle.client.shutdown().catch(() => {});
        return null;
      }
      this.ready.set(key, handle);
      return handle;
    } catch (err) {
      this.broken.add(key);
      if (err instanceof LspInstallError) {
        const hint = err.hint ? ` (${err.hint})` : '';
        // eslint-disable-next-line no-console -- surfaced to stderr, not TUI
        console.error(`[lsp] ${err.message}${hint}`);
      } else {
        // Non-install failures (spawn errors, timeouts) carry useful stacks.
        // eslint-disable-next-line no-console -- surfaced to stderr, not TUI
        console.error(
          `[lsp] ${contribution.id} @ ${root} failed to start:`,
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      }
      return null;
    } finally {
      this.pending.delete(key);
    }
  }

  private async spawnClient(
    contribution: LspServerContribution,
    root: string,
  ): Promise<ClientHandle> {
    if (this.clientFactory) {
      const onPublish = (uri: string, diagnostics: ReadonlyArray<Diagnostic>): void => {
        this.diagnostics.recordPush(uri, diagnostics);
      };
      const client = this.clientFactory({
        contribution,
        root,
        onPublishDiagnostics: onPublish,
      });
      await client.start();
      return {
        client,
        contribution,
        root,
      };
    }
    const command = await resolveLaunchCommand(contribution.launch, contribution.id);
    const client = new LspClient({
      id: contribution.id,
      root,
      command,
      initializationOptions: contribution.initializationOptions,
      onPublishDiagnostics: (params) => this.diagnostics.recordPush(params.uri, params.diagnostics),
    });
    try {
      await client.start();
    } catch (err) {
      await client.shutdown().catch(() => {});
      throw err;
    }
    return {
      client,
      contribution,
      root,
    };
  }
}

//#endregion

//#region Helpers

function clientKey(id: string, root: string): string {
  return `${id}|${root}`;
}

//#endregion
