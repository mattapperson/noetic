/**
 * REST API for Noetic UI
 *
 * Provides HTTP endpoints for querying execution traces
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import type { Run } from '../shared/protocol.js';
import type { TraceStorage } from './storage.js';

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
        console.log(`Noetic UI API listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  /**
   * Stop the API server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.isRunning = false;
    console.log('Noetic UI API server stopped');
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

      // Route handling
      if (pathname === '/api/agents' && method === 'GET') {
        response = await this.listAgents();
      } else if (
        pathname.startsWith('/api/agents/') &&
        pathname.endsWith('/runs') &&
        method === 'GET'
      ) {
        const agentId = pathname.split('/')[3];
        response = await this.listAgentRuns(agentId);
      } else if (pathname.startsWith('/api/runs/') && method === 'GET') {
        const runId = pathname.split('/')[3];
        const agentId = url.searchParams.get('agentId') || 'default';
        response = await this.getRun(agentId, runId);
      } else if (pathname.startsWith('/api/runs/') && method === 'DELETE') {
        const runId = pathname.split('/')[3];
        const agentId = url.searchParams.get('agentId') || 'default';
        response = await this.deleteRun(agentId, runId);
      } else if (pathname === '/api/metrics' && method === 'GET') {
        response = await this.getMetrics();
      } else if (pathname === '/health' && method === 'GET') {
        response = {
          success: true,
          data: {
            status: 'ok',
          },
        };
      } else {
        response = {
          success: false,
          error: 'Not found',
        };
        res.writeHead(404, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify(response));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(response));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('API error:', error);
      res.writeHead(500, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          success: false,
          error: errorMessage,
        }),
      );
    }
  }

  private async listAgents(): Promise<APIResponse<string[]>> {
    const agents = await this.config.storage.listAgents();
    return {
      success: true,
      data: agents,
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
