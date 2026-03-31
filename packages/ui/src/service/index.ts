/**
 * Server entry point for Noetic UI
 *
 * Combines WebSocket and REST API servers for the Noetic UI debugging interface.
 * This module is the main entry point for the server-side infrastructure.
 */

import type { NoeticUIAPI } from './api.js';
import { getAPI } from './api.js';
import type { TraceStorage } from './storage.js';
import { getStorage } from './storage.js';
import type { NoeticUIServer } from './websocket.js';
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
// CLI Entry Point
// ============================================================================

// Start server when this file is run directly
// @ts-expect-error Bun-specific import.meta.main property
if (import.meta.main) {
  const PORT_WS = Number.parseInt(process.env.NOETIC_UI_WS_PORT || '3333', 10);
  const PORT_API = Number.parseInt(process.env.NOETIC_UI_API_PORT || '3334', 10);
  const HOST = process.env.NOETIC_UI_HOST || '127.0.0.1';

  console.log('🔮 Noetic UI Server');
  console.log('');

  const manager = new NoeticUIServerManager({
    wsPort: PORT_WS,
    apiPort: PORT_API,
    host: HOST,
  });

  manager
    .start()
    .then(() => {
      console.log('');
      console.log('✅ Server is running');
      console.log(`WebSocket: ws://${HOST}:${PORT_WS}`);
      console.log(`Web UI: http://${HOST}:${PORT_API}`);
      console.log('');
      console.log('Press Ctrl+C to stop');
    })
    .catch((error) => {
      console.error('❌ Failed to start server:', error.message);
      process.exit(1);
    });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await manager.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await manager.stop();
    process.exit(0);
  });
}
