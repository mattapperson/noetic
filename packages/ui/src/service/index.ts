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

    console.info('[Server] All servers started successfully');
    console.info(`[Server] WebSocket: ws://${this.options.host}:${this.options.wsPort}`);
    console.info(`[Server] API/Web: http://${this.options.host}:${this.options.apiPort}`);
  }

  /**
   * Stop all servers gracefully
   * Waits for pending requests and connections to close
   * @param timeoutMs Maximum time to wait for graceful shutdown (default: 10000ms)
   */
  async stop(timeoutMs = 10000): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.info('[Server] Starting graceful shutdown...');
    const startTime = Date.now();

    // Stop API server first to stop accepting new HTTP requests
    await this.apiServer.stop(timeoutMs);

    // Stop WebSocket server (notifies clients and closes connections)
    const remainingTime = timeoutMs - (Date.now() - startTime);
    await this.wsServer.stop(Math.max(1000, remainingTime));

    this.isRunning = false;
    console.info('[Server] All servers stopped gracefully');
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<ServerStatus> {
    return {
      isRunning: this.isRunning,
      wsStatus: this.wsServer.getStatus(),
      apiStatus: this.apiServer.getStatus(),
      storagePath: await this.storage.getStoragePath(),
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
 * @param manager The server manager instance
 * @param timeoutMs Maximum time to wait for graceful shutdown (default: 10000ms)
 */
export async function stopNoeticUI(
  manager: NoeticUIServerManager,
  timeoutMs = 10000,
): Promise<void> {
  await manager.stop(timeoutMs);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

// Start server when this file is run directly
if (import.meta.main) {
  const PORT_WS = Number.parseInt(process.env.NOETIC_UI_WS_PORT || '3333', 10);
  const PORT_API = Number.parseInt(process.env.NOETIC_UI_API_PORT || '3334', 10);
  const HOST = process.env.NOETIC_UI_HOST || '127.0.0.1';
  const SHUTDOWN_TIMEOUT = Number.parseInt(process.env.NOETIC_UI_SHUTDOWN_TIMEOUT || '10000', 10);

  console.info('[CLI] 🔮 Noetic UI Server');
  console.info('');

  const manager = new NoeticUIServerManager({
    wsPort: PORT_WS,
    apiPort: PORT_API,
    host: HOST,
  });

  let isShuttingDown = false;

  /**
   * Graceful shutdown handler
   */
  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      console.warn('\n[CLI] Shutdown already in progress, forcing exit...');
      process.exit(1);
    }

    isShuttingDown = true;
    console.info(`\n[CLI] Received ${signal}, starting graceful shutdown...`);
    console.info(`[CLI] Timeout: ${SHUTDOWN_TIMEOUT}ms`);

    try {
      await manager.stop(SHUTDOWN_TIMEOUT);
      console.info('[CLI] Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('[CLI] Error during shutdown:', error);
      console.warn('[CLI] Forcing exit...');
      process.exit(1);
    }
  }

  // Set up signal handlers
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('[CLI] Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[CLI] Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
  });

  manager
    .start()
    .then(() => {
      console.info('');
      console.info('[CLI] Server is running');
      console.info(`[CLI] WebSocket: ws://${HOST}:${PORT_WS}`);
      console.info(`[CLI] Web UI: http://${HOST}:${PORT_API}`);
      console.info(`[CLI] PID: ${process.pid}`);
      console.info('');
      console.info('[CLI] Press Ctrl+C to stop');
    })
    .catch((error) => {
      console.error('[CLI] Failed to start server:', error.message);
      process.exit(1);
    });
}
