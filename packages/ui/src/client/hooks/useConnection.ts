import { useEffect, useState } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import { isServerMessage } from '../../shared/protocol';
import type { WebSocketClient, WebSocketMessage } from '../lib/websocket-client';
import { createWebSocketClient } from '../lib/websocket-client';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

interface UseConnectionOptions {
  url?: string;
  autoConnect?: boolean;
  onServerMessage?: (message: ServerMessage) => void;
}

interface UseConnectionReturn {
  status: ConnectionStatus;
  client: WebSocketClient | null;
  connect: () => void;
  disconnect: () => void;
  send: (message: WebSocketMessage) => void;
  lastServerMessage: ServerMessage | null;
}

export function useConnection(options: UseConnectionOptions = {}): UseConnectionReturn {
  const { url = 'ws://localhost:3333', autoConnect = true, onServerMessage } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [client, setClient] = useState<WebSocketClient | null>(null);
  const [lastServerMessage, setLastServerMessage] = useState<ServerMessage | null>(null);

  useEffect(() => {
    const wsClient = createWebSocketClient(url, {
      onMessage: (message) => {
        // Validate message is a ServerMessage and call callback
        if (isServerMessage(message)) {
          setLastServerMessage(message);
          onServerMessage?.(message);
        }
      },
      onStatusChange: (newStatus) => {
        setStatus(newStatus);
      },
      onError: () => {
        // Error is handled by status change, no need to log to console
        // Connection indicator in UI shows the status
      },
    });

    setClient(wsClient);

    if (autoConnect) {
      wsClient.connect();
    }

    return () => {
      wsClient.disconnect();
    };
  }, [
    url,
    autoConnect,
    onServerMessage,
  ]);

  const connect = () => {
    client?.connect();
  };

  const disconnect = () => {
    client?.disconnect();
  };

  const send = (message: WebSocketMessage): void => {
    client?.send(message);
  };

  return {
    status,
    client,
    connect,
    disconnect,
    send,
    lastServerMessage,
  };
}

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  useEffect(() => {
    // For now, just return disconnected - will be connected to real hook later
    setStatus('disconnected');
  }, []);

  return status;
}
