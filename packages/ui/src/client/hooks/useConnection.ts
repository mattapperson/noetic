import { useEffect, useState } from 'react';
import type { WebSocketClient } from '../lib/websocket-client';
import { createWebSocketClient } from '../lib/websocket-client';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

interface UseConnectionOptions {
  url?: string;
  autoConnect?: boolean;
}

interface UseConnectionReturn {
  status: ConnectionStatus;
  client: WebSocketClient | null;
  connect: () => void;
  disconnect: () => void;
  send: (message: unknown) => void;
  lastMessage: unknown | null;
}

export function useConnection(options: UseConnectionOptions = {}): UseConnectionReturn {
  const { url = 'ws://localhost:3333', autoConnect = true } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [client, setClient] = useState<WebSocketClient | null>(null);
  const [lastMessage, setLastMessage] = useState<unknown>(null);

  useEffect(() => {
    const wsClient = createWebSocketClient(url, {
      onMessage: (message) => {
        setLastMessage(message);
      },
      onStatusChange: (newStatus) => {
        setStatus(newStatus);
      },
      onError: (error) => {
        console.error('WebSocket error:', error);
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
  ]);

  const connect = () => {
    client?.connect();
  };

  const disconnect = () => {
    client?.disconnect();
  };

  const send = (message: unknown): void => {
    if (!client) {
      return;
    }
    if (typeof message === 'object' && message !== null) {
      client.send(message as Record<string, unknown>);
    }
  };

  return {
    status,
    client,
    connect,
    disconnect,
    send,
    lastMessage,
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
