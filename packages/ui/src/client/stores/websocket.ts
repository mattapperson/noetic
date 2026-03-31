'use client';

/**
 * WebSocket connection store for Noetic UI
 *
 * Provides a singleton WebSocket connection that can be used across components.
 * Messages are processed immediately through callbacks to avoid missing rapid-fire messages.
 */

import { create } from 'zustand';
import type { ServerMessage } from '../../shared/protocol';
import { isServerMessage } from '../../shared/protocol';
import type { WebSocketClient } from '../lib/websocket-client';
import { createWebSocketClient } from '../lib/websocket-client';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

interface WebSocketState {
  // Connection state
  status: ConnectionStatus;
  client: WebSocketClient | null;
  lastMessage: ServerMessage | null;

  // Actions
  connect: (url?: string) => void;
  disconnect: () => void;
  send: (message: unknown) => void;
  setStatus: (status: ConnectionStatus) => void;
  processMessage: (message: ServerMessage) => void;
}

// Global message handler registry
const messageHandlers = new Set<(message: ServerMessage) => void>();

export function registerMessageHandler(handler: (message: ServerMessage) => void): () => void {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

export const useWebSocketStore = create<WebSocketState>((set, get) => ({
  status: 'disconnected',
  client: null,
  lastMessage: null,

  connect: (url = 'ws://localhost:3333') => {
    // Only run on client
    if (typeof window === 'undefined') {
      return;
    }

    const { client: existingClient } = get();

    // Don't create multiple connections
    if (existingClient) {
      console.log('[WebSocketStore] Connection already exists, skipping');
      return;
    }

    console.log('[WebSocketStore] Creating new WebSocket connection to', url);

    const client = createWebSocketClient(url, {
      onMessage: (message) => {
        if (isServerMessage(message)) {
          console.log('[WebSocketStore] Message received:', message.type);

          // Update last message
          set({
            lastMessage: message,
          });

          // Notify all registered handlers immediately
          messageHandlers.forEach((handler) => {
            try {
              handler(message);
            } catch (error) {
              console.error('[WebSocketStore] Handler error:', error);
            }
          });
        } else {
          console.warn('[WebSocketStore] Invalid message format:', message);
        }
      },
      onStatusChange: (status) => {
        console.log('[WebSocketStore] Status changed:', status);
        set({
          status: status as ConnectionStatus,
        });
      },
      onError: (error) => {
        console.error('[WebSocketStore] Connection error:', error);
      },
    });

    set({
      client,
    });
    client.connect();
  },

  disconnect: () => {
    // Only run on client
    if (typeof window === 'undefined') {
      return;
    }

    const { client } = get();
    if (client) {
      client.disconnect();
      set({
        client: null,
        status: 'disconnected',
      });
    }
  },

  send: (message: unknown) => {
    // Only run on client
    if (typeof window === 'undefined') {
      return;
    }

    const { client } = get();
    if (client) {
      client.send(
        message as {
          type: string;
        },
      );
    } else {
      console.warn('[WebSocketStore] Cannot send, not connected');
    }
  },

  setStatus: (status: ConnectionStatus) => {
    set({
      status,
    });
  },

  processMessage: (message: ServerMessage) => {
    set({
      lastMessage: message,
    });
  },
}));
