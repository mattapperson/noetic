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
import { deserialize } from '../lib/serialization';
import type { WebSocketClient, WebSocketMessage } from '../lib/websocket-client';
import { createWebSocketClient } from '../lib/websocket-client';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

interface WebSocketState {
  // Connection state
  status: ConnectionStatus;
  client: WebSocketClient | null;
  lastMessage: ServerMessage | null;
  reconnectAttempt: number;

  // Actions
  connect: (url?: string) => void;
  disconnect: () => void;
  send: (message: unknown) => void;
  setStatus: (status: ConnectionStatus) => void;
  setReconnectAttempt: (attempt: number) => void;
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
  reconnectAttempt: 0,

  connect: (url = 'ws://localhost:3333') => {
    // Only run on client
    if (typeof window === 'undefined') {
      return;
    }

    const { client: existingClient } = get();

    // Don't create multiple connections
    if (existingClient) {
      console.debug('[WebSocketStore] Connection already exists, skipping');
      return;
    }

    console.info('[WebSocketStore] Creating new WebSocket connection to', url);

    const client = createWebSocketClient(url, {
      onMessage: (message) => {
        if (isServerMessage(message)) {
          console.debug('[WebSocketStore] Message received:', message.type);

          // Deserialize the message to convert any serialized Maps back to Map instances
          // deserialize returns T and message is already validated as ServerMessage
          const deserializedMessage: ServerMessage = deserialize(message);

          // Update last message
          set({
            lastMessage: deserializedMessage,
          });

          // Notify all registered handlers immediately
          messageHandlers.forEach((handler) => {
            try {
              handler(deserializedMessage);
            } catch (error) {
              console.error('[WebSocketStore] Handler error:', error);
            }
          });
        } else {
          console.warn('[WebSocketStore] Invalid message format:', message);
        }
      },
      onStatusChange: (statusValue) => {
        console.info('[WebSocketStore] Status changed:', statusValue);
        const status: ConnectionStatus = statusValue;
        set({
          status,
        });
        // Reset reconnect attempt counter when connected
        if (status === 'connected') {
          set({
            reconnectAttempt: 0,
          });
        }
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
        reconnectAttempt: 0,
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
      // Type guard to validate message has required type field
      if (
        message !== null &&
        typeof message === 'object' &&
        'type' in message &&
        typeof (message as Record<string, unknown>).type === 'string'
      ) {
        client.send(message as WebSocketMessage);
      } else {
        console.warn('[WebSocketStore] Cannot send, message missing type field:', message);
      }
    } else {
      console.warn('[WebSocketStore] Cannot send, not connected');
    }
  },

  setStatus: (status: ConnectionStatus) => {
    set({
      status,
    });
  },

  setReconnectAttempt: (attempt: number) => {
    set({
      reconnectAttempt: attempt,
    });
  },

  processMessage: (message: ServerMessage) => {
    set({
      lastMessage: message,
    });
  },
}));
