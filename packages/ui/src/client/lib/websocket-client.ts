type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
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
  private lastPingTime = 0;
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
          const parsedData: unknown = JSON.parse(event.data);
          if (typeof parsedData !== 'object' || parsedData === null || !('type' in parsedData)) {
            throw new Error('Invalid message format');
          }
          const message = parsedData as WebSocketMessage;

          // Handle pong response
          if (message.type === 'pong') {
            this.handlePong();
            return;
          }

          this.onMessage(message);
        } catch (err) {
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

      this.ws.onerror = (error) => {
        this.onError(new Error('WebSocket error'));
      };
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.setStatus('disconnected');
    }
  }

  disconnect(): void {
    this.stopReconnect();
    this.stopHeartbeat();

    if (this.ws) {
      // Don't reconnect on intentional close
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    this.setStatus('disconnected');
  }

  send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue message if disconnected
      if (this.messageQueue.length < 1000) {
        this.messageQueue.push(message);
      }
    }
  }

  ping(): void {
    this.send({
      type: 'ping',
      timestamp: Date.now(),
    });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.onStatusChange(status);
    }
  }

  private scheduleReconnect(): void {
    // Check if max reconnect duration exceeded (5 minutes)
    if (this.reconnectStartTime === 0) {
      this.reconnectStartTime = Date.now();
    } else if (Date.now() - this.reconnectStartTime > this.maxReconnectDuration) {
      this.setStatus('disconnected');
      this.onError(new Error('Max reconnection duration exceeded (5 minutes)'));
      return;
    }

    // Calculate exponential backoff delay: 1s → 2s → 4s → 8s → max 30s
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
    this.reconnectAttempts = 0;
    this.reconnectStartTime = 0;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.lastPingTime = Date.now();
      this.ping();

      // Set timeout for pong response
      this.heartbeatTimeoutTimer = setTimeout(() => {
        this.missedHeartbeats++;

        // After 2 missed heartbeats (10s total), trigger reconnection
        if (this.missedHeartbeats >= 2) {
          this.stopHeartbeat();
          this.setStatus('reconnecting');
          if (this.ws) {
            this.ws.close();
          }
          this.scheduleReconnect();
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
    this.missedHeartbeats = 0;
  }

  private handlePong(): void {
    this.missedHeartbeats = 0;
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
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
