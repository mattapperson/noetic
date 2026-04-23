/**
 * LspClient — thin wrapper over a `ProtocolConnection` from
 * `vscode-languageserver-protocol`. Owns the child process, the JSON-RPC
 * connection, and the set of currently-open document URIs. Exposes one method
 * per LSP operation we care about plus lifecycle (`start` / `shutdown`).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentDiagnosticReport,
  DocumentSymbol,
  Hover,
  InitializeParams,
  Location,
  Position,
  ProtocolConnection,
  PublishDiagnosticsParams,
  SymbolInformation,
  WorkspaceSymbol,
} from 'vscode-languageserver-protocol';
import {
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  ImplementationRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
  WorkspaceSymbolRequest,
} from 'vscode-languageserver-protocol/node.js';

import type { ResolvedCommand } from './types.js';

//#region Types

export interface LspClientOptions {
  id: string;
  root: string;
  command: ResolvedCommand;
  initializationOptions?: unknown;
  onPublishDiagnostics?: (params: PublishDiagnosticsParams) => void;
  /** Invoked with each stderr chunk from the server. Off by default — servers are noisy. */
  onStderr?: (chunk: string) => void;
  initializeTimeoutMs?: number;
}

export type DefinitionResult = Definition | DefinitionLink[] | null;
export type ReferencesResult = Location[] | null;
export type HoverResult = Hover | null;
export type DocumentSymbolResult = DocumentSymbol[] | SymbolInformation[] | null;
export type WorkspaceSymbolResult = SymbolInformation[] | WorkspaceSymbol[] | null;
export type CallHierarchyPrepareResult = CallHierarchyItem[] | null;
export type IncomingCallsResult = CallHierarchyIncomingCall[] | null;
export type OutgoingCallsResult = CallHierarchyOutgoingCall[] | null;

//#endregion

//#region Constants

const DEFAULT_INITIALIZE_TIMEOUT_MS = 45e3;

const CLIENT_CAPABILITIES: InitializeParams['capabilities'] = {
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: {
      dynamicRegistration: false,
    },
    diagnostics: {
      refreshSupport: true,
    },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: false,
    },
    hover: {
      contentFormat: [
        'markdown',
        'plaintext',
      ],
    },
    definition: {
      linkSupport: true,
    },
    references: {},
    implementation: {
      linkSupport: true,
    },
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
    },
    publishDiagnostics: {
      relatedInformation: true,
    },
    diagnostic: {
      dynamicRegistration: false,
      relatedDocumentSupport: false,
    },
    callHierarchy: {
      dynamicRegistration: false,
    },
  },
};

//#endregion

//#region Helpers

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

//#endregion

//#region LspClient

/**
 * The public API the `LspService` relies on. Extracted as an interface so tests
 * can provide a fake client without resorting to `as unknown as LspClient` casts.
 * The concrete `LspClient` class below implements this interface over a real
 * JSON-RPC connection.
 */
export interface LspClientApi {
  readonly id: string;
  readonly root: string;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  openOrUpdate(uri: string, languageId: string, text: string): Promise<void>;
  close(uri: string): Promise<void>;
  isOpen(uri: string): boolean;
  hover(uri: string, position: Position): Promise<HoverResult>;
  definition(uri: string, position: Position): Promise<DefinitionResult>;
  references(uri: string, position: Position): Promise<ReferencesResult>;
  implementation(uri: string, position: Position): Promise<DefinitionResult>;
  documentSymbol(uri: string): Promise<DocumentSymbolResult>;
  workspaceSymbol(query: string): Promise<WorkspaceSymbolResult>;
  prepareCallHierarchy(uri: string, position: Position): Promise<CallHierarchyPrepareResult>;
  incomingCalls(item: CallHierarchyItem): Promise<IncomingCallsResult>;
  outgoingCalls(item: CallHierarchyItem): Promise<OutgoingCallsResult>;
  pullDiagnostics(uri: string): Promise<ReadonlyArray<Diagnostic>>;
}

export class LspClient implements LspClientApi {
  readonly id: string;
  readonly root: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: ProtocolConnection | null = null;
  private readonly openDocs = new Map<string, number>();
  private readonly lastSentText = new Map<string, string>();
  private readonly initializeTimeoutMs: number;
  private readonly command: ResolvedCommand;
  private readonly initializationOptions?: unknown;
  private readonly onPublishDiagnostics?: (params: PublishDiagnosticsParams) => void;
  private readonly onStderr?: (chunk: string) => void;

  constructor(opts: LspClientOptions) {
    this.id = opts.id;
    this.root = opts.root;
    this.command = opts.command;
    this.initializationOptions = opts.initializationOptions;
    this.onPublishDiagnostics = opts.onPublishDiagnostics;
    this.onStderr = opts.onStderr;
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const proc = spawn(
      this.command.executable,
      [
        ...this.command.args,
      ],
      {
        cwd: this.root,
        stdio: [
          'pipe',
          'pipe',
          'pipe',
        ],
      },
    );
    this.process = proc;
    // Drain stderr unconditionally to prevent backpressure. Forward to an
    // optional consumer if one is registered; servers log here routinely.
    proc.stderr.on('data', (chunk: Buffer) => {
      this.onStderr?.(chunk.toString('utf8'));
    });
    const connection = createProtocolConnection(proc.stdout, proc.stdin);
    this.connection = connection;
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.onPublishDiagnostics?.(params);
    });
    connection.listen();
    const rootUri = pathToFileURL(this.root).href;
    await withTimeout(
      connection.sendRequest(InitializeRequest.type, {
        processId: process.pid ?? null,
        rootUri,
        capabilities: CLIENT_CAPABILITIES,
        workspaceFolders: [
          {
            uri: rootUri,
            name: this.root,
          },
        ],
        initializationOptions: this.initializationOptions,
      }),
      this.initializeTimeoutMs,
      `LSP initialize for '${this.id}'`,
    );
    await connection.sendNotification(InitializedNotification.type, {});
  }

  async shutdown(): Promise<void> {
    const connection = this.connection;
    const proc = this.process;
    this.connection = null;
    this.process = null;
    // Always kill the spawned process, even if connection setup never completed
    // (e.g. start() threw after spawn but before createProtocolConnection).
    // Attempt a graceful LSP shutdown first when we have a live connection.
    if (connection) {
      try {
        await withTimeout(connection.sendRequest(ShutdownRequest.type, undefined), 2e3, 'shutdown');
        await connection.sendNotification(ExitNotification.type);
      } catch {
        // Fall through to force-kill.
      } finally {
        connection.dispose();
      }
    }
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 2e3).unref();
    }
  }

  async openOrUpdate(uri: string, languageId: string, text: string): Promise<void> {
    const connection = this.requireConnection();
    const previousVersion = this.openDocs.get(uri);
    if (previousVersion === undefined) {
      this.openDocs.set(uri, 1);
      this.lastSentText.set(uri, text);
      await connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text,
        },
      });
      return;
    }
    // Skip didChange when content is unchanged — repeated tool queries against the
    // same file would otherwise spam the server with no-op version bumps.
    if (this.lastSentText.get(uri) === text) {
      return;
    }
    const nextVersion = previousVersion + 1;
    this.openDocs.set(uri, nextVersion);
    this.lastSentText.set(uri, text);
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: {
        uri,
        version: nextVersion,
      },
      contentChanges: [
        {
          text,
        },
      ],
    });
  }

  async close(uri: string): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    if (!this.openDocs.has(uri)) {
      return;
    }
    this.openDocs.delete(uri);
    this.lastSentText.delete(uri);
    await connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: {
        uri,
      },
    });
  }

  isOpen(uri: string): boolean {
    return this.openDocs.has(uri);
  }

  async hover(uri: string, position: Position): Promise<HoverResult> {
    return this.requireConnection().sendRequest(HoverRequest.type, {
      textDocument: {
        uri,
      },
      position,
    });
  }

  async definition(uri: string, position: Position): Promise<DefinitionResult> {
    return this.requireConnection().sendRequest(DefinitionRequest.type, {
      textDocument: {
        uri,
      },
      position,
    });
  }

  async references(uri: string, position: Position): Promise<ReferencesResult> {
    return this.requireConnection().sendRequest(ReferencesRequest.type, {
      textDocument: {
        uri,
      },
      position,
      context: {
        includeDeclaration: true,
      },
    });
  }

  async implementation(uri: string, position: Position): Promise<DefinitionResult> {
    return this.requireConnection().sendRequest(ImplementationRequest.type, {
      textDocument: {
        uri,
      },
      position,
    });
  }

  async documentSymbol(uri: string): Promise<DocumentSymbolResult> {
    return this.requireConnection().sendRequest(DocumentSymbolRequest.type, {
      textDocument: {
        uri,
      },
    });
  }

  async workspaceSymbol(query: string): Promise<WorkspaceSymbolResult> {
    return this.requireConnection().sendRequest(WorkspaceSymbolRequest.type, {
      query,
    });
  }

  async prepareCallHierarchy(uri: string, position: Position): Promise<CallHierarchyPrepareResult> {
    return this.requireConnection().sendRequest(CallHierarchyPrepareRequest.type, {
      textDocument: {
        uri,
      },
      position,
    });
  }

  async incomingCalls(item: CallHierarchyItem): Promise<IncomingCallsResult> {
    return this.requireConnection().sendRequest(CallHierarchyIncomingCallsRequest.type, {
      item,
    });
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<OutgoingCallsResult> {
    return this.requireConnection().sendRequest(CallHierarchyOutgoingCallsRequest.type, {
      item,
    });
  }

  async pullDiagnostics(uri: string): Promise<ReadonlyArray<Diagnostic>> {
    const report: DocumentDiagnosticReport = await this.requireConnection().sendRequest(
      DocumentDiagnosticRequest.type,
      {
        textDocument: {
          uri,
        },
      },
    );
    switch (report.kind) {
      case 'full':
        return report.items;
      case 'unchanged':
        // Server says no change since last pull — callers rely on the push
        // channel for the prior state; returning [] here doesn't clobber it.
        return [];
      default: {
        // Protocol guarantees no other kinds today; exhaustiveness check.
        const _exhaustive: never = report;
        void _exhaustive;
        return [];
      }
    }
  }

  private requireConnection(): ProtocolConnection {
    if (!this.connection) {
      throw new Error(`LspClient '${this.id}' is not connected`);
    }
    return this.connection;
  }
}

//#endregion
