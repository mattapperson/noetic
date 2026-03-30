/**
 * WebSocket server module for Noetic UI
 *
 * Implements the WebSocket protocol with:
 * - Ping/pong heartbeat (client ping every 30s, server pong within 5s)
 * - Message buffering during disconnection (up to 1000 messages)
 * - Exponential backoff reconnection support (client-side concern)
 * - Protocol handlers for execution events and control messages
 */

import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  ClientMessage,
  ExecutionNode,
  ExecutionSummary,
  ExecutionTrace,
  NodeStatus,
  NoeticError,
  RunStatus,
  ServerMessage,
} from '../shared/protocol.js';
import { TraceStorage } from './storage.js';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = '127.0.0.1'; // Bind to localhost only for security
const HEARTBEAT_INTERVAL_MS = 30000; // Client ping every 30s
const PONG_TIMEOUT_MS = 5000; // Server must respond within 5s
const MAX_BUFFER_SIZE = 1000; // Max messages to buffer

// ============================================================================
// Types
// ============================================================================

interface ClientConnection {
  ws: WebSocket;
  id: string;
  connectedAt: number;
  lastPingAt: number;
  lastPongAt: number;
  messageBuffer: ServerMessage[];
  isAlive: boolean;
}

interface ServerConfig {
  port: number;
  host: string;
  storage?: TraceStorage;
}

interface TraceState {
  trace: ExecutionTrace;
  agentId: string;
  isLive: boolean;
}

// ============================================================================
// Noetic UI WebSocket Server
// ============================================================================

export class NoeticUIServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private clients = new Map<string, ClientConnection>();
  private traces = new Map<string, TraceState>();
  private storage: TraceStorage;
  private config: ServerConfig;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = {
      port: config.port || DEFAULT_PORT,
      host: config.host || DEFAULT_HOST,
      storage: config.storage,
    };
    this.storage = config.storage || new TraceStorage();
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    // Initialize storage
    await this.storage.init();

    // Create HTTP server (for potential REST API endpoints)
    this.httpServer = createServer();

    // Create WebSocket server
    this.wss = new WebSocketServer({
      server: this.httpServer,
      host: this.config.host,
    });

    // Handle connections
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        console.log(`Noetic UI server listening on ws://${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    // Start heartbeat check
    this.startHeartbeat();
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close(1000, 'Server shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.isRunning = false;
    console.log('Noetic UI server stopped');
  }

  /**
   * Get server status
   */
  getStatus(): {
    isRunning: boolean;
    port: number;
    host: string;
    clientCount: number;
  } {
    return {
      isRunning: this.isRunning,
      port: this.config.port,
      host: this.config.host,
      clientCount: this.clients.size,
    };
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      this.sendToClient(client, message);
    }
  }

  /**
   * Send execution start event
   */
  async startExecution(trace: ExecutionTrace, agentId: string): Promise<void> {
    this.traces.set(trace.traceId, {
      trace,
      agentId,
      isLive: true,
    });

    const message: ServerMessage = {
      type: 'execution.start',
      trace,
    };

    this.broadcast(message);
    await this.saveTrace(trace, agentId);
  }

  /**
   * Send node start event
   */
  nodeStarted(traceId: string, node: ExecutionNode): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    traceState.trace.nodes.set(node.id, node);

    const message: ServerMessage = {
      type: 'node.start',
      node,
    };

    this.broadcast(message);
  }

  /**
   * Send node complete event
   */
  nodeCompleted(traceId: string, nodeId: string, output: unknown, durationMs: number): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    const node = traceState.trace.nodes.get(nodeId);
    if (node) {
      node.output = output;
      node.durationMs = durationMs;
      node.endTime = Date.now();
      node.status = 'completed';
    }

    const message: ServerMessage = {
      type: 'node.complete',
      nodeId,
      output,
      durationMs,
    };

    this.broadcast(message);
  }

  /**
   * Send node error event
   */
  nodeError(traceId: string, nodeId: string, error: NoeticError): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    const node = traceState.trace.nodes.get(nodeId);
    if (node) {
      node.error = error;
      node.status = 'error';
      node.endTime = Date.now();
    }

    const message: ServerMessage = {
      type: 'node.error',
      nodeId,
      error,
    };

    this.broadcast(message);
  }

  /**
   * Send node pause event
   */
  nodePaused(traceId: string, nodeId: string, reason: 'breakpoint' | 'step' | 'error'): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace status
    traceState.trace.status = 'paused';

    // Update node
    const node = traceState.trace.nodes.get(nodeId);
    if (node) {
      node.status = 'paused';
    }

    const message: ServerMessage = {
      type: 'node.pause',
      nodeId,
      reason,
    };

    this.broadcast(message);
  }

  /**
   * Send node data update
   */
  nodeData(traceId: string, nodeId: string, data: Partial<ExecutionNode>): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update node
    const node = traceState.trace.nodes.get(nodeId);
    if (node) {
      Object.assign(node, data);
    }

    const message: ServerMessage = {
      type: 'node.data',
      nodeId,
      data,
    };

    this.broadcast(message);
  }

  /**
   * Send execution complete event
   */
  async executionComplete(traceId: string, summary: ExecutionSummary): Promise<void> {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    traceState.trace.status = 'completed';
    traceState.trace.endTime = Date.now();
    traceState.isLive = false;

    const message: ServerMessage = {
      type: 'execution.complete',
      traceId,
      summary,
    };

    this.broadcast(message);
    await this.saveTrace(traceState.trace, traceState.agentId);
  }

  /**
   * Send execution error event
   */
  async executionError(traceId: string, error: NoeticError): Promise<void> {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    traceState.trace.status = 'error';
    traceState.trace.endTime = Date.now();
    traceState.isLive = false;

    const message: ServerMessage = {
      type: 'execution.error',
      traceId,
      error,
    };

    this.broadcast(message);
    await this.saveTrace(traceState.trace, traceState.agentId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    const clientId = this.generateClientId();
    const now = Date.now();

    const client: ClientConnection = {
      ws,
      id: clientId,
      connectedAt: now,
      lastPingAt: 0,
      lastPongAt: now,
      messageBuffer: [],
      isAlive: true,
    };

    this.clients.set(clientId, client);
    console.log(`Client connected: ${clientId}`);

    // Handle messages
    ws.on('message', (data) => {
      this.handleMessage(client, data);
    });

    // Handle ping/pong
    ws.on('ping', () => {
      ws.pong();
      client.lastPongAt = Date.now();
    });

    ws.on('pong', () => {
      client.isAlive = true;
      client.lastPongAt = Date.now();
    });

    // Handle close
    ws.on('close', () => {
      this.clients.delete(clientId);
      console.log(`Client disconnected: ${clientId}`);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error);
      this.clients.delete(clientId);
    });

    // Send initial connection ack
    this.sendToClient(client, {
      type: 'pong',
      timestamp: now,
    });
  }

  private handleMessage(client: ClientConnection, data: Buffer | ArrayBuffer | Buffer[]): void {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      this.processClientMessage(client, message);
    } catch (error) {
      console.error('Failed to parse client message:', error);
    }
  }

  private processClientMessage(client: ClientConnection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        // Respond with pong
        this.sendToClient(client, {
          type: 'pong',
          timestamp: Date.now(),
        });
        break;

      case 'execution.list':
        // List active/completed executions
        this.handleExecutionList(client);
        break;

      case 'execution.get':
        // Get specific execution trace
        this.handleExecutionGet(client, message.traceId);
        break;

      case 'execution.replay':
        // Replay execution from specific point
        this.handleExecutionReplay(client, message.traceId, message.fromNodeId);
        break;

      case 'node.stepOver':
      case 'node.stepInto':
      case 'node.stepOut':
      case 'node.resume':
        // Control messages - forward to runtime (implementation in runtime module)
        console.log(`Received control message: ${message.type}`);
        break;

      case 'breakpoint.add':
      case 'breakpoint.remove':
        // Breakpoint management - forward to runtime
        console.log(`Received breakpoint message: ${message.type}`);
        break;

      default:
        console.warn(
          `Unknown message type: ${
            (
              message as {
                type: string;
              }
            ).type
          }`,
        );
    }
  }

  private handleExecutionList(client: ClientConnection): void {
    // Send list of traces
    const traceList = Array.from(this.traces.values()).map((ts) => ({
      traceId: ts.trace.traceId,
      agentId: ts.agentId,
      status: ts.trace.status,
      startTime: ts.trace.startTime,
      isLive: ts.isLive,
    }));

    this.sendToClient(client, {
      type: 'execution.complete',
      traceId: 'list',
      summary: {
        traceId: 'list',
        totalNodes: traceList.length,
        completedNodes: 0,
        errorNodes: 0,
        durationMs: 0,
        totalTokens: {
          input: 0,
          output: 0,
          total: 0,
        },
        totalCost: 0,
      },
    });
  }

  private handleExecutionGet(client: ClientConnection, traceId: string): void {
    const traceState = this.traces.get(traceId);
    if (traceState) {
      this.sendToClient(client, {
        type: 'execution.start',
        trace: traceState.trace,
      });
    }
  }

  private handleExecutionReplay(
    client: ClientConnection,
    traceId: string,
    fromNodeId?: string,
  ): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Send execution start
    this.sendToClient(client, {
      type: 'execution.start',
      trace: traceState.trace,
    });

    // Replay nodes from beginning or from specified node
    let replayStarted = !fromNodeId;
    for (const node of traceState.trace.nodes.values()) {
      if (!replayStarted && node.id === fromNodeId) {
        replayStarted = true;
      }

      if (replayStarted) {
        this.sendToClient(client, {
          type: 'node.start',
          node,
        });

        if (node.status === 'completed' && node.output !== null) {
          this.sendToClient(client, {
            type: 'node.complete',
            nodeId: node.id,
            output: node.output,
            durationMs: node.durationMs || 0,
          });
        } else if (node.status === 'error' && node.error) {
          this.sendToClient(client, {
            type: 'node.error',
            nodeId: node.id,
            error: node.error,
          });
        }
      }
    }
  }

  private sendToClient(client: ClientConnection, message: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('Failed to send message to client:', error);
        this.bufferMessage(client, message);
      }
    } else {
      this.bufferMessage(client, message);
    }
  }

  private bufferMessage(client: ClientConnection, message: ServerMessage): void {
    if (client.messageBuffer.length >= MAX_BUFFER_SIZE) {
      // Drop oldest message
      client.messageBuffer.shift();
    }
    client.messageBuffer.push(message);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const client of this.clients.values()) {
        // Check if client hasn't sent ping in expected timeframe
        if (client.lastPingAt > 0 && now - client.lastPongAt > PONG_TIMEOUT_MS * 2) {
          console.warn(`Client ${client.id} missed heartbeats, terminating`);
          client.ws.terminate();
          this.clients.delete(client.id);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async saveTrace(trace: ExecutionTrace, agentId: string): Promise<void> {
    try {
      // Get root node input for storage
      const rootNode = trace.nodes.get(trace.rootNodeId);
      const input = rootNode?.input || {};

      await this.storage.saveTrace(
        trace,
        agentId,
        input,
        this.traces.get(trace.traceId)?.isLive || false,
      );
    } catch (error) {
      console.error('Failed to save trace:', error);
    }
  }

  private generateClientId(): string {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalServer: NoeticUIServer | null = null;

export function getServer(config?: Partial<ServerConfig>): NoeticUIServer {
  if (!globalServer) {
    globalServer = new NoeticUIServer(config);
  }
  return globalServer;
}

export function resetServer(): void {
  globalServer = null;
}
