/**
 * Connection store for managing WebSocket connection status
 */

import { create } from 'zustand';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface ConnectionStore {
  // Connection state
  status: ConnectionStatus;
  lastPingTime: number | null;
  reconnectAttempt: number;
  lastError: string | null;

  // Actions
  setConnected: () => void;
  setConnecting: () => void;
  setDisconnected: (error?: string) => void;
  recordPing: () => void;
  incrementReconnectAttempt: () => void;
  resetReconnectAttempt: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'disconnected',
  lastPingTime: null,
  reconnectAttempt: 0,
  lastError: null,

  setConnected: () => {
    set({
      status: 'connected',
      reconnectAttempt: 0,
      lastError: null,
    });
  },

  setConnecting: () => {
    set({
      status: 'connecting',
    });
  },

  setDisconnected: (error?: string) => {
    set({
      status: 'disconnected',
      lastError: error ?? null,
    });
  },

  recordPing: () => {
    set({
      lastPingTime: Date.now(),
    });
  },

  incrementReconnectAttempt: () => {
    set((state) => ({
      reconnectAttempt: state.reconnectAttempt + 1,
    }));
  },

  resetReconnectAttempt: () => {
    set({
      reconnectAttempt: 0,
    });
  },
}));

// Selector hooks
export const useConnectionStatus = () => useConnectionStore((state) => state.status);
export const useIsConnected = () => useConnectionStore((state) => state.status === 'connected');
