'use client';

import { useEffect } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import type { ConnectionStatus } from '../stores/websocket';
import { registerMessageHandler, useWebSocketStore } from '../stores/websocket';

interface UseConnectionOptions {
  url?: string;
  autoConnect?: boolean;
  onServerMessage?: (message: ServerMessage) => void;
}

interface UseConnectionReturn {
  status: ConnectionStatus;
  connect: () => void;
  disconnect: () => void;
  send: (message: unknown) => void;
  lastServerMessage: ServerMessage | null;
}

export function useConnection(options: UseConnectionOptions = {}): UseConnectionReturn {
  const { url = 'ws://localhost:3333', autoConnect = true, onServerMessage } = options;

  const { status, connect: storeConnect, disconnect, send, lastMessage } = useWebSocketStore();

  // Register message handler
  useEffect(() => {
    if (!onServerMessage) return;

    console.log('[useConnection] Registering message handler');
    return registerMessageHandler(onServerMessage);
  }, [
    onServerMessage,
  ]);

  // Connect on mount if autoConnect is true
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (autoConnect && status === 'disconnected') {
      console.log('[useConnection] Auto-connecting...');
      storeConnect(url);
    }
  }, [
    autoConnect,
    status,
    url,
    storeConnect,
  ]);

  const connect = () => {
    if (typeof window === 'undefined') return;
    storeConnect(url);
  };

  return {
    status,
    connect,
    disconnect,
    send,
    lastServerMessage: lastMessage,
  };
}

export function useConnectionStatus(): ConnectionStatus {
  return useWebSocketStore((state) => state.status);
}
