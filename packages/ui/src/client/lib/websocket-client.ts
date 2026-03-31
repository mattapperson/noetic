'use client';

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Type guard to validate WebSocket message structure
 */
function isWebSocketMessage(value: unknown): value is WebSocketMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // Type guard requires casting from unknown to check properties
  // This is the only way to validate object structure at runtime in TypeScript
  // biome-ignore lint: Type guard implementation requires property access on unknown
  const obj = value as {
    type: unknown;
  };
  return 'type' in value && typeof obj.type === 'string';
}

interface WebSocketClientOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  reconnectDecay?: number;
  maxReconnectAttempts?: number;
  maxReconnectDuration?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: (message: WebSocketMessage) => void;
  private onStatusChange: (status: ConnectionStatus) => void;
  private onError: (error: Error) => void;

  // Reconnection settings (from spec)
  private reconnectInterval: number;
  private maxReconnectInterval: number;
  private reconnectDecay: number;
  private maxReconnectAttempts: number;
  private maxReconnectDuration: number;

  // Heartbeat settings (from spec)
  private heartbeatInterval: number;
  private heartbeatTimeout: number;

  // State
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private missedHeartbeats = 0;
  private reconnectStartTime = 0;
  private messageQueue: WebSocketMessage[] = [];

  constructor(options: WebSocketClientOptions) {
    this.url = options.url;
    this.onMessage = options.onMessage || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});

    // Reconnection defaults based on spec: 1s → 2s → 4s → 8s → max 30s
    this.reconnectInterval = options.reconnectInterval || 1000;
    this.maxReconnectInterval = options.maxReconnectInterval || 30000;
    this.reconnectDecay = options.reconnectDecay || 2;
    this.maxReconnectAttempts = options.maxReconnectAttempts || Number.POSITIVE_INFINITY;
    this.maxReconnectDuration = options.maxReconnectDuration || 5 * 60 * 1000; // 5 minutes

    // Heartbeat defaults based on spec: ping every 30s, timeout after 5s (2 missed = reconnect)
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.heartbeatTimeout = options.heartbeatTimeout || 5000;
  }

  connect(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.setStatus('connected');
        this.reconnectAttempts = 0;
        this.missedHeartbeats = 0;
        this.reconnectStartTime = 0;

        // Flush queued messages
        this.flushQueue();

        // Start heartbeat
        this.startHeartbeat();

        // Send sync request for missed events (if reconnected after disconnection)
        if (this.messageQueue.length > 0) {
          this.send({
            type: 'execution.list',
          });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const parsedData = JSON.parse(event.data);
          if (!isWebSocketMessage(parsedData)) {
            throw new Error('Invalid message format');
          }

          // Handle pong response
          if (parsedData.type === 'pong') {
            this.handlePong();
            return;
          }

          this.onMessage(parsedData);
        } catch (_err) {
          this.onError(new Error(`Failed to parse message: ${event.data}`));
        }
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();

        if (this.status === 'connected') {
          // Unexpected close, attempt reconnect
          this.setStatus('reconnecting');
          this.scheduleReconnect();
        } else {
          this.setStatus('disconnected');
        }
      };

      this.ws.onerror = (_error) => {
        this.onError(new Error('WebSocket error'));
      };
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.setStatus('disconnected');
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.stopReconnect();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setStatus('disconnected');
  }

  send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue message for later
      this.messageQueue.push(message);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.onStatusChange(status);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.missedHeartbeats >= 2) {
        // Too many missed heartbeats, reconnect
        this.ws?.close();
        return;
      }

      // Send ping
      this.send({
        type: 'ping',
        timestamp: Date.now(),
      });

      this.missedHeartbeats++;

      // Set timeout to wait for pong
      this.heartbeatTimeoutTimer = setTimeout(() => {
        if (this.missedHeartbeats > 0) {
          // Missed heartbeat, will be handled by next ping cycle
        }
      }, this.heartbeatTimeout);
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private handlePong(): void {
    this.missedHeartbeats = 0;

    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (typeof window === 'undefined') {
      return;
    }

    // Check if we've exceeded max reconnect duration
    if (this.reconnectStartTime === 0) {
      this.reconnectStartTime = Date.now();
    } else if (Date.now() - this.reconnectStartTime > this.maxReconnectDuration) {
      this.setStatus('disconnected');
      return;
    }

    // Check if we've exceeded max reconnect attempts
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setStatus('disconnected');
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.reconnectInterval * this.reconnectDecay ** this.reconnectAttempts,
      this.maxReconnectInterval,
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }
}

// Factory function for creating a WebSocket client with default options
export function createWebSocketClient(
  url: string,
  handlers: Pick<WebSocketClientOptions, 'onMessage' | 'onStatusChange' | 'onError'>,
): WebSocketClient {
  return new WebSocketClient({
    url,
    ...handlers,
  });
}
