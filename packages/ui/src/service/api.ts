/**
 * REST API for Noetic UI
 *
 * Provides HTTP endpoints for querying execution traces
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Run } from '../shared/protocol.js';
import type { TraceStorage } from './storage.js';

// ============================================================================
// JSON Serialization Helpers
// ============================================================================

/**
 * JSON replacer for serializing Maps
 * Matches the replacer used in TraceStorage
 */
function serializeValue(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return {
      dataType: 'Map',
      value: Array.from(value.entries()),
    };
  }
  return value;
}

/**
 * Serialize API response with proper Map handling
 */
function serializeResponse<T>(response: APIResponse<T>): string {
  return JSON.stringify(response, serializeValue);
}

// ============================================================================
// Types
// ============================================================================

export interface APIConfig {
  port: number;
  host: string;
  storage: TraceStorage;
}

interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Run summary type that omits the full trace for list responses
 */
type RunSummary = Omit<Run, 'trace'> & {
  trace?: undefined;
};

// ============================================================================
// Noetic UI API Server
// ============================================================================

export class NoeticUIAPI {
  private server: ReturnType<typeof createServer> | null = null;
  private config: APIConfig;
  private isRunning = false;

  constructor(
    config: Partial<APIConfig> & {
      storage: TraceStorage;
    },
  ) {
    this.config = {
      port: config.port || 3334,
      host: config.host || '127.0.0.1',
      storage: config.storage,
    };
  }

  /**
   * Start the API server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('API server is already running');
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        console.info(`[API] Server listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  /**
   * Stop the API server gracefully
   * Waits for pending requests to complete
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.info('[API] Starting graceful shutdown...');

    if (this.server) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[API] Server close timeout exceeded, forcing shutdown');
          resolve();
        }, timeoutMs);

        // Stop accepting new connections
        this.server!.close(() => {
          clearTimeout(timeout);
          console.info('[API] Server stopped gracefully');
          resolve();
        });
      });
      this.server = null;
    }

    this.isRunning = false;
  }

  /**
   * Get server status
   */
  getStatus(): {
    isRunning: boolean;
    port: number;
    host: string;
  } {
    return {
      isRunning: this.isRunning,
      port: this.config.port,
      host: this.config.host,
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      let response: APIResponse;

      // Route handling - RESTful nested resource pattern
      // /api/agents - Agent collection
      // /api/agents/:agentId - Specific agent
      // /api/agents/:agentId/runs - Runs collection for agent
      // /api/agents/:agentId/runs/:runId - Specific run

      // Normalize pathname by removing trailing slash (except for root)
      const normalizedPath =
        pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

      if (normalizedPath === '/api/agents' && method === 'GET') {
        response = await this.listAgents();
      } else if (normalizedPath.match(/^\/api\/agents\/[^/]+$/) && method === 'GET') {
        const agentId = normalizedPath.split('/')[3];
        response = await this.getAgent(agentId);
      } else if (normalizedPath.match(/^\/api\/agents\/[^/]+$/) && method === 'DELETE') {
        const agentId = normalizedPath.split('/')[3];
        response = await this.deleteAgent(agentId);
      } else if (normalizedPath.match(/^\/api\/agents\/[^/]+\/runs$/) && method === 'GET') {
        const agentId = normalizedPath.split('/')[3];
        response = await this.listAgentRuns(agentId);
      } else if (normalizedPath.match(/^\/api\/agents\/[^/]+\/runs\/[^/]+$/) && method === 'GET') {
        const parts = normalizedPath.split('/');
        const agentId = parts[3];
        const runId = parts[5];
        response = await this.getRun(agentId, runId);
      } else if (
        normalizedPath.match(/^\/api\/agents\/[^/]+\/runs\/[^/]+$/) &&
        method === 'DELETE'
      ) {
        const parts = normalizedPath.split('/');
        const agentId = parts[3];
        const runId = parts[5];
        response = await this.deleteRun(agentId, runId);
      } else if (normalizedPath === '/api/metrics' && method === 'GET') {
        response = await this.getMetrics();
      } else if (normalizedPath === '/health' && method === 'GET') {
        response = {
          success: true,
          data: {
            status: 'ok',
          },
        };
      } else if (normalizedPath.startsWith('/api/')) {
        // API route that didn't match any specific handler
        console.warn(`[API] Unmatched route: ${method} ${normalizedPath} (original: ${pathname})`);
        response = {
          success: false,
          error: 'Not found',
        };
        res.writeHead(404, {
          'Content-Type': 'application/json',
        });
        res.end(serializeResponse(response));
        return;
      } else {
        // Non-API routes - return 404 (Next.js handles static files in dev, use a reverse proxy in production)
        response = {
          success: false,
          error: 'Not found',
        };
        res.writeHead(404, {
          'Content-Type': 'application/json',
        });
        res.end(serializeResponse(response));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(serializeResponse(response));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[API] Error:', error);
      res.writeHead(500, {
        'Content-Type': 'application/json',
      });
      res.end(
        serializeResponse({
          success: false,
          error: errorMessage,
        }),
      );
    }
  }

  private async listAgents(): Promise<APIResponse<string[]>> {
    const startTime = Date.now();
    const agents = await this.config.storage.listAgents();
    console.log(`[API] listAgents: ${agents.length} agents in ${Date.now() - startTime}ms`);
    return {
      success: true,
      data: agents,
    };
  }

  private async getAgent(agentId: string): Promise<
    APIResponse<{
      id: string;
      runs: number;
    }>
  > {
    const runs = await this.config.storage.listAgentRuns(agentId);
    return {
      success: true,
      data: {
        id: agentId,
        runs: runs.length,
      },
    };
  }

  private async deleteAgent(agentId: string): Promise<
    APIResponse<{
      deleted: boolean;
      runsDeleted: number;
    }>
  > {
    // Delete all runs for the agent
    const runsDeleted = await this.config.storage.deleteAgentRuns(agentId);

    // Delete the agent directory (will only succeed if empty)
    await this.config.storage.deleteAgentDirectory(agentId);

    // Unregister the agent from persistence
    await this.config.storage.unregisterAgent(agentId);

    return {
      success: true,
      data: {
        deleted: true,
        runsDeleted,
      },
    };
  }

  private async listAgentRuns(agentId: string): Promise<APIResponse<RunSummary[]>> {
    const runs = await this.config.storage.listAgentRuns(agentId);
    // Sanitize runs for API response (remove large trace data)
    const sanitizedRuns: RunSummary[] = runs.map((run) => ({
      ...run,
      trace: undefined, // Don't send full trace in list
    }));
    return {
      success: true,
      data: sanitizedRuns,
    };
  }

  private async getRun(agentId: string, runId: string): Promise<APIResponse<Run>> {
    const run = await this.config.storage.loadRun(agentId, runId);
    if (!run) {
      return {
        success: false,
        error: 'Run not found',
      };
    }
    return {
      success: true,
      data: run,
    };
  }

  private async deleteRun(
    agentId: string,
    runId: string,
  ): Promise<
    APIResponse<{
      deleted: boolean;
    }>
  > {
    const deleted = await this.config.storage.deleteRun(agentId, runId);
    return {
      success: deleted,
      data: {
        deleted,
      },
    };
  }

  private async getMetrics(): Promise<APIResponse> {
    const metrics = await this.config.storage.getMetrics();
    // Convert Map to plain object for JSON serialization
    const byAgent: Record<
      string,
      {
        runCount: number;
        sizeBytes: number;
      }
    > = {};
    for (const [agentId, data] of metrics.byAgent) {
      byAgent[agentId] = data;
    }
    return {
      success: true,
      data: {
        totalRuns: metrics.totalRuns,
        totalSizeBytes: metrics.totalSizeBytes,
        byAgent,
      },
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalAPI: NoeticUIAPI | null = null;

export function getAPI(
  config: Partial<APIConfig> & {
    storage: TraceStorage;
  },
): NoeticUIAPI {
  if (!globalAPI) {
    globalAPI = new NoeticUIAPI(config);
  }
  return globalAPI;
}

export function resetAPI(): void {
  globalAPI = null;
}
