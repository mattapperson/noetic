/**
 * Server entry point for Noetic UI
 *
 * Combines WebSocket and REST API servers for the Noetic UI debugging interface.
 * This module is the main entry point for the server-side infrastructure.
 */

import { getAPI } from './api.js';
import { getStorage } from './storage.js';
import { getServer } from './websocket.js';

// ============================================================================
// Re-exports
// ============================================================================

export type { ExecutionNode, ExecutionSummary, ExecutionTrace } from '../shared/protocol.js';
export type { APIConfig } from './api.js';
export { getAPI, NoeticUIAPI, resetAPI } from './api.js';
export type { SaveResult, StorageMetrics, StorageWarning } from './storage.js';
export { getStorage, resetStorage, TraceStorage } from './storage.js';
export type { ClientConnection, ServerConfig } from './websocket.js';
export { getServer, NoeticUIServer, resetServer } from './websocket.js';

// ============================================================================
// Combined Server Manager
// ============================================================================

interface NoeticUIServerOptions {
  /** WebSocket server port (default: 3333) */
  wsPort?: number;
  /** API server port (default: 3334) */
  apiPort?: number;
  /** Server host (default: 127.0.0.1) */
  host?: string;
  /** Custom storage path */
  storagePath?: string;
}

interface ServerStatus {
  isRunning: boolean;
  wsStatus: {
    isRunning: boolean;
    port: number;
    host: string;
    clientCount: number;
  };
  apiStatus: {
    isRunning: boolean;
    port: number;
    host: string;
  };
  storagePath: string;
}

export class NoeticUIServerManager {
  private wsServer: NoeticUIServer;
  private apiServer: NoeticUIAPI;
  private storage: TraceStorage;
  private options: NoeticUIServerOptions;
  private isRunning = false;

  constructor(options: NoeticUIServerOptions = {}) {
    this.options = {
      wsPort: options.wsPort || 3333,
      apiPort: options.apiPort || 3334,
      host: options.host || '127.0.0.1',
      storagePath: options.storagePath,
    };

    // Initialize storage
    this.storage = getStorage(this.options.storagePath);

    // Initialize servers
    this.wsServer = getServer({
      port: this.options.wsPort,
      host: this.options.host,
      storage: this.storage,
    });

    this.apiServer = getAPI({
      port: this.options.apiPort,
      host: this.options.host,
      storage: this.storage,
    });
  }

  /**
   * Start all servers
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Server manager is already running');
    }

    await this.wsServer.start();
    await this.apiServer.start();
    this.isRunning = true;

    console.log('Noetic UI servers started successfully');
    console.log(`WebSocket: ws://${this.options.host}:${this.options.wsPort}`);
    console.log(`API: http://${this.options.host}:${this.options.apiPort}`);
  }

  /**
   * Stop all servers
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    await this.wsServer.stop();
    await this.apiServer.stop();
    this.isRunning = false;

    console.log('Noetic UI servers stopped');
  }

  /**
   * Get server status
   */
  getStatus(): ServerStatus {
    return {
      isRunning: this.isRunning,
      wsStatus: this.wsServer.getStatus(),
      apiStatus: this.apiServer.getStatus(),
      storagePath: this.storage.getStoragePath(),
    };
  }

  /**
   * Get the WebSocket server instance
   */
  getWebSocketServer(): NoeticUIServer {
    return this.wsServer;
  }

  /**
   * Get the API server instance
   */
  getAPIServer(): NoeticUIAPI {
    return this.apiServer;
  }

  /**
   * Get the storage instance
   */
  getStorage(): TraceStorage {
    return this.storage;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Start the Noetic UI servers with default configuration
 */
export async function startNoeticUI(
  options: NoeticUIServerOptions = {},
): Promise<NoeticUIServerManager> {
  const manager = new NoeticUIServerManager(options);
  await manager.start();
  return manager;
}

/**
 * Stop all Noetic UI servers
 */
export async function stopNoeticUI(manager: NoeticUIServerManager): Promise<void> {
  await manager.stop();
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager: NoeticUIServerManager | null = null;

/**
 * Get or create the global server manager instance
 */
export function getServerManager(options?: NoeticUIServerOptions): NoeticUIServerManager {
  if (!globalManager) {
    globalManager = new NoeticUIServerManager(options);
  }
  return globalManager;
}

/**
 * Reset the global server manager instance
 */
export function resetServerManager(): void {
  globalManager = null;
}
