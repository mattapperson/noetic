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
  AgentInfo,
  ClientMessage,
  ExecutionNode,
  ExecutionSummary,
  ExecutionTrace,
  NoeticError,
  ServerMessage,
} from '../shared/protocol.js';
import { isClientMessage, isServerMessage } from '../shared/protocol.js';
import type { TraceStorage } from './storage.js';
import { getStorage } from './storage.js';

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

export interface ClientConnection {
  ws: WebSocket;
  id: string;
  connectedAt: number;
  lastPingAt: number;
  lastPongAt: number;
  messageBuffer: ServerMessage[];
  isAlive: boolean;
}

export interface ServerConfig {
  port: number;
  host: string;
  storage?: TraceStorage;
}

interface TraceState {
  trace: ExecutionTrace;
  agentId: string;
  isLive: boolean;
  input: unknown;
}

// ============================================================================
// Noetic UI WebSocket Server
// ============================================================================

export class NoeticUIServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private clients = new Map<string, ClientConnection>();
  private traces = new Map<string, TraceState>();
  private registeredAgents = new Map<
    string,
    {
      name: string;
      registeredAt: number;
    }
  >();
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
    this.storage = config.storage || getStorage();
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
        console.info(
          `[WebSocket] Server listening on ws://${this.config.host}:${this.config.port}`,
        );
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    // Start heartbeat check
    this.startHeartbeat();
  }

  /**
   * Stop the WebSocket server gracefully
   * Notifies all clients and closes connections properly
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.info('[WebSocket] Starting graceful shutdown...');

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Notify all clients about shutdown
    const shutdownMessage = JSON.stringify({
      type: 'server.shutdown',
      timestamp: Date.now(),
      message: 'Server is shutting down',
    });

    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(shutdownMessage);
          client.ws.close(1001, 'Server shutting down'); // 1001 = Going Away
        } catch {
          // Client may already be closing
        }
      }
    }

    // Wait a moment for clients to receive the message
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clear all clients
    this.clients.clear();

    // Close WebSocket server with timeout
    if (this.wss) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[WebSocket] Server close timeout exceeded');
          resolve();
        }, timeoutMs);

        this.wss!.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.wss = null;
    }

    // Close HTTP server with timeout
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[WebSocket] HTTP server close timeout exceeded');
          resolve();
        }, timeoutMs);

        this.httpServer!.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.httpServer = null;
    }

    this.isRunning = false;
    console.info('[WebSocket] Server stopped gracefully');
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
      input: {},
    });

    const message: ServerMessage = {
      type: 'execution.start',
      agentId,
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
      agentId: traceState.agentId,
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
      agentId: traceState.agentId,
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
    console.info(`[WebSocket] Client connected: ${clientId}`);

    // Handle messages
    ws.on('message', (data) => {
      this.handleMessage(client, data).catch((error) => {
        console.error('[WebSocket] Failed to handle message:', error);
      });
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
      console.info(`[WebSocket] Client disconnected: ${clientId}`);
    });

    ws.on('error', (error) => {
      console.error(`[WebSocket] Error for client ${clientId}:`, error);
      this.clients.delete(clientId);
    });

    // Send initial connection ack
    this.sendToClient(client, {
      type: 'pong',
      timestamp: now,
    });
  }

  private async handleMessage(
    client: ClientConnection,
    data: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    try {
      const parsed = JSON.parse(data.toString());
      // Accept both ClientMessage (from UI) and ServerMessage (from agent runtime)
      if (!isClientMessage(parsed) && !isServerMessage(parsed)) {
        console.error('[WebSocket] Received invalid message format');
        return;
      }
      await this.processClientMessage(client, parsed);
    } catch (error) {
      console.error('Failed to parse client message:', error);
    }
  }

  private async processClientMessage(
    client: ClientConnection,
    message: ClientMessage | ServerMessage,
  ): Promise<void> {
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
        await this.handleExecutionList(client);
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
        // TODO: Implement debugging controls - currently disabled
        // These would require bidirectional communication with the agent runtime
        console.warn(`[WebSocket] Debugging control ${message.type} not yet implemented`);
        this.sendToClient(client, {
          type: 'execution.error',
          agentId: 'system',
          traceId: message.traceId,
          error: {
            message: `Debugging control ${message.type} is not yet implemented`,
            code: 'NOT_IMPLEMENTED',
          },
        });
        break;

      case 'breakpoint.add':
      case 'breakpoint.remove':
        // TODO: Implement breakpoint management - currently disabled
        console.warn(`[WebSocket] Breakpoint ${message.type} not yet implemented`);
        break;

      // Agent -> Server trace messages
      case 'agent.register':
        await this.handleAgentRegister(message.agentId, message.agentName);
        break;

      case 'trace.start':
        this.handleTraceStart(message.traceId, message.agentId, message.input, message.startTime);
        break;

      case 'trace.nodeStart':
        this.handleTraceNodeStart(message.traceId, message.node);
        break;

      case 'trace.nodeComplete':
        this.handleTraceNodeComplete(
          message.traceId,
          message.nodeId,
          message.output,
          message.durationMs,
        );
        break;

      case 'trace.nodeError':
        this.handleTraceNodeError(message.traceId, message.nodeId, message.error);
        break;

      case 'trace.complete':
        this.handleTraceComplete(message.traceId, message.summary, message.endTime);
        break;

      case 'trace.error':
        this.handleTraceError(message.traceId, message.error, message.endTime);
        break;

      // Handle ServerMessage types from agent runtime (forwarded by exporter)
      case 'execution.start':
        // Already handled by trace.start - just broadcast to clients
        this.broadcast(message);
        break;

      case 'node.start':
        // Node already tracked by trace.nodeStart - just broadcast
        this.broadcast(message);
        break;

      case 'node.complete':
        // Node already tracked by trace.nodeComplete - just broadcast
        this.broadcast(message);
        break;

      case 'node.error':
        // Node already tracked by trace.nodeError - just broadcast
        this.broadcast(message);
        break;

      case 'execution.complete':
        // Already handled by trace.complete - just broadcast
        this.broadcast(message);
        break;

      case 'execution.error':
        // Already handled by trace.error - just broadcast
        this.broadcast(message);
        break;

      case 'pong':
        // Heartbeat response - no action needed
        break;

      default: {
        // Exhaustiveness check - if we get here, it's an unknown message type
        // but isClientMessage validated it has a 'type' property
        // Type is 'never' here due to exhaustive switch, but we know it has 'type' from validation
        const msgWithType: {
          type: string;
        } = message;
        console.warn(`Unknown message type: ${msgWithType.type}`);
      }
    }
  }

  private async handleExecutionList(client: ClientConnection): Promise<void> {
    const agents: AgentInfo[] = [];

    // Include in-memory live traces
    const seenAgents = new Set<string>();
    for (const [, ts] of this.traces) {
      if (!seenAgents.has(ts.agentId)) {
        seenAgents.add(ts.agentId);
        agents.push({
          agentId: ts.agentId,
          name: ts.agentId,
          runCount: 1,
        });
      }
    }

    // Include persisted agents from storage
    try {
      const storedAgents = await this.storage.listAgents();
      for (const agentId of storedAgents) {
        if (!seenAgents.has(agentId)) {
          seenAgents.add(agentId);
          const runs = await this.storage.listAgentRuns(agentId);
          agents.push({
            agentId,
            name: agentId,
            runCount: runs.length,
          });
        }
      }
    } catch {
      // Storage may not be available
    }

    this.sendToClient(client, {
      type: 'execution.list.response',
      agents,
    });
  }

  private handleExecutionGet(client: ClientConnection, traceId: string): void {
    const traceState = this.traces.get(traceId);
    if (traceState) {
      this.sendToClient(client, {
        type: 'execution.start',
        agentId: traceState.agentId,
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
      agentId: traceState.agentId,
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
          console.warn(`[WebSocket] Client ${client.id} missed heartbeats, terminating`);
          client.ws.terminate();
          this.clients.delete(client.id);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async saveTrace(trace: ExecutionTrace, agentId: string): Promise<void> {
    try {
      // Get input from trace state, fallback to root node input
      const traceState = this.traces.get(trace.traceId);
      const rootNode = trace.nodes.get(trace.rootNodeId);
      const input = traceState?.input ?? rootNode?.input ?? {};

      await this.storage.saveTrace(trace, agentId, input, traceState?.isLive ?? false);
    } catch (error) {
      console.error('Failed to save trace:', error);
    }
  }

  // ============================================================================
  // Agent Trace Message Handlers
  // ============================================================================

  private async handleAgentRegister(agentId: string, agentName: string): Promise<void> {
    console.info(`[WebSocket] Agent registered: ${agentName} (${agentId})`);
    // Track registered agent in memory
    this.registeredAgents.set(agentId, {
      name: agentName,
      registeredAt: Date.now(),
    });
    // Also register with storage so API can list it (persisted to disk)
    await this.storage.registerAgent(agentId, agentName);
  }

  private handleTraceStart(
    traceId: string,
    agentId: string,
    input: unknown,
    startTime: number,
  ): void {
    console.info(`[WebSocket] Trace started: ${traceId} for agent ${agentId}`);

    // Create new trace
    const trace: ExecutionTrace = {
      traceId,
      rootStepId: 'root',
      startTime,
      endTime: null,
      status: 'running',
      nodes: new Map(),
      rootNodeId: '',
    };

    // Store trace state
    this.traces.set(traceId, {
      trace,
      agentId,
      isLive: true,
      input,
    });

    // Broadcast to all clients
    this.broadcast({
      type: 'execution.start',
      agentId,
      trace,
    });
  }

  private handleTraceNodeStart(traceId: string, node: ExecutionNode): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      console.warn(`[WebSocket] Trace not found: ${traceId}`);
      return;
    }

    // Add node to trace
    traceState.trace.nodes.set(node.id, node);

    // Set rootNodeId if not already set and this node's parent doesn't exist in trace
    // (meaning this is the top-most node being exported)
    if (!traceState.trace.rootNodeId) {
      const parentExists = node.parentId && traceState.trace.nodes.has(node.parentId);
      if (!parentExists) {
        traceState.trace.rootNodeId = node.id;
        console.info(`[WebSocket] Set root node: ${node.id}`);
      }
    }

    // Broadcast to all clients
    this.broadcast({
      type: 'node.start',
      node,
    });
  }

  private handleTraceNodeComplete(
    traceId: string,
    nodeId: string,
    output: unknown,
    durationMs: number,
  ): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    const node = traceState.trace.nodes.get(nodeId);
    if (!node) {
      return;
    }

    // Update node
    node.output = output;
    node.durationMs = durationMs;
    node.endTime = Date.now();
    node.status = 'completed';

    // Broadcast to all clients
    this.broadcast({
      type: 'node.complete',
      nodeId,
      output,
      durationMs,
    });
  }

  private handleTraceNodeError(traceId: string, nodeId: string, error: NoeticError): void {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    const node = traceState.trace.nodes.get(nodeId);
    if (node) {
      node.error = error;
      node.status = 'error';
    }

    // Broadcast to all clients
    this.broadcast({
      type: 'node.error',
      nodeId,
      error,
    });
  }

  private async handleTraceComplete(
    traceId: string,
    summary: ExecutionSummary,
    endTime: number,
  ): Promise<void> {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    traceState.trace.status = 'completed';
    traceState.trace.endTime = endTime;
    traceState.isLive = false;

    // Broadcast to all clients
    this.broadcast({
      type: 'execution.complete',
      agentId: traceState.agentId,
      traceId,
      summary,
    });

    // Save to storage
    await this.saveTrace(traceState.trace, traceState.agentId);

    // Clean up completed trace from memory after a delay
    // (keep it briefly to allow clients to fetch final state)
    setTimeout(() => {
      this.traces.delete(traceId);
      console.info(`[WebSocket] Cleaned up completed trace: ${traceId}`);
    }, 30000); // Keep for 30 seconds after completion
  }

  private async handleTraceError(
    traceId: string,
    error: NoeticError,
    endTime: number,
  ): Promise<void> {
    const traceState = this.traces.get(traceId);
    if (!traceState) {
      return;
    }

    // Update trace
    traceState.trace.status = 'error';
    traceState.trace.endTime = endTime;
    traceState.isLive = false;

    // Broadcast to all clients
    this.broadcast({
      type: 'execution.error',
      agentId: traceState.agentId,
      traceId,
      error,
    });

    // Save to storage (even errored traces are saved for debugging)
    await this.saveTrace(traceState.trace, traceState.agentId);

    // Clean up errored trace from memory after a delay
    setTimeout(() => {
      this.traces.delete(traceId);
      console.info(`[WebSocket] Cleaned up errored trace: ${traceId}`);
    }, 30000);
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
