/**
 * REST API for Noetic UI
 *
 * Provides HTTP endpoints for querying execution traces
 * and serves the Next.js web UI static files
 */

import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// Static File Resolution
// ============================================================================

/**
 * Find the dist directory containing static files.
 * Tries multiple locations to support both development and installed package modes.
 */
function findDistDirectory(): string | null {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFilePath);

  // Search upward for package.json to find package root
  let searchDir = currentDir;
  let iterations = 0;
  const maxIterations = 20; // Prevent infinite loop

  while (iterations < maxIterations) {
    iterations++;
    const packageJsonPath = join(searchDir, 'package.json');

    if (existsSync(packageJsonPath)) {
      // Found a package.json - check if it's @noetic/ui
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

        // Check for dist folder at this package root
        const distPath = join(searchDir, 'dist');

        if (existsSync(distPath)) {
          const indexPath = join(distPath, 'index.html');
          if (existsSync(indexPath)) {
            return distPath;
          }
        }

        // If this is @noetic/ui package, stop searching
        if (pkg.name === '@noetic/ui') {
          break;
        }
      } catch {
        // Ignore errors reading package.json
      }
    }

    const parentDir = dirname(searchDir);
    if (parentDir === searchDir) {
      break; // Reached filesystem root
    }
    searchDir = parentDir;
  }

  // Fallback: try common relative paths
  const possiblePaths = [
    // From src/server/api.ts -> ../../../dist (package root)
    join(currentDir, '..', '..', '..', 'dist'),
    // One level up
    join(currentDir, '..', '..', 'dist'),
    // Two levels up
    join(currentDir, '..', 'dist'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      const indexPath = join(path, 'index.html');
      if (existsSync(indexPath)) {
        return path;
      }
    }
  }

  return null;
}

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
   * Stop the API server gracefully
   * Waits for pending requests to complete
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[API] Starting graceful shutdown...');

    if (this.server) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[API] Server close timeout exceeded, forcing shutdown');
          resolve();
        }, timeoutMs);

        // Stop accepting new connections
        this.server!.close(() => {
          clearTimeout(timeout);
          console.log('[API] Server stopped gracefully');
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
      if (pathname === '/api/agents' && method === 'GET') {
        response = await this.listAgents();
      } else if (pathname.match(/^\/api\/agents\/[^/]+$/) && method === 'DELETE') {
        const agentId = pathname.split('/')[3];
        response = await this.deleteAgent(agentId);
      } else if (pathname.match(/^\/api\/agents\/[^/]+\/runs$/) && method === 'GET') {
        const agentId = pathname.split('/')[3];
        response = await this.listAgentRuns(agentId);
      } else if (pathname.match(/^\/api\/agents\/[^/]+\/runs\/[^/]+$/) && method === 'GET') {
        const parts = pathname.split('/');
        const agentId = parts[3];
        const runId = parts[5];
        response = await this.getRun(agentId, runId);
      } else if (pathname.match(/^\/api\/agents\/[^/]+\/runs\/[^/]+$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const agentId = parts[3];
        const runId = parts[5];
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
      } else if (pathname.startsWith('/api/')) {
        // API route that didn't match any specific handler
        response = {
          success: false,
          error: 'Not found',
        };
        res.writeHead(404, {
          'Content-Type': 'application/json',
        });
        res.end(serializeResponse(response));
        return;
      } else if (method === 'GET') {
        // Try to serve static files for non-API routes
        const served = await this.serveStaticFile(pathname, res);
        if (served) {
          return;
        }
        // If static file not found, return 404
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
      console.error('API error:', error);
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
    const agents = await this.config.storage.listAgents();
    return {
      success: true,
      data: agents,
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

  /**
   * Serve static files from the dist directory
   */
  private async serveStaticFile(pathname: string, res: ServerResponse): Promise<boolean> {
    // Find the dist directory
    const distPath = findDistDirectory();
    if (!distPath) {
      console.error('[API] Could not find dist directory with static files');
      return false;
    }

    // Default to index.html for root paths and SPA routes
    let filePath: string;
    if (pathname === '/' || !pathname.includes('.')) {
      filePath = join(distPath, 'index.html');
    } else {
      // Remove leading slash and join with dist path
      const cleanPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
      filePath = join(distPath, cleanPath);
    }

    // Security check: ensure the file is within distPath
    if (!filePath.startsWith(distPath)) {
      return false;
    }

    if (!existsSync(filePath)) {
      // If the file doesn't exist and it's not an API route, serve index.html for SPA routing
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/health')) {
        filePath = join(distPath, 'index.html');
        if (!existsSync(filePath)) {
          return false;
        }
      } else {
        return false;
      }
    }

    try {
      const content = readFileSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase();

      // Set content type based on file extension
      const contentType: Record<string, string> = {
        html: 'text/html',
        js: 'application/javascript',
        css: 'text/css',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        ico: 'image/x-icon',
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
      };

      res.writeHead(200, {
        'Content-Type': contentType[ext || ''] || 'application/octet-stream',
      });
      res.end(content);
      return true;
    } catch (error) {
      console.error('[API] Error serving static file:', error);
      return false;
    }
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
