/**
 * Playback store for managing playback state
 * Controls play/pause, speed, and transport operations
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type PlaybackSpeed = 1 | 2 | 5 | 10;

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'live';

export interface PlaybackStore {
  // Playback state
  state: PlaybackState;
  speed: PlaybackSpeed;

  // Position tracking
  currentStepIndex: number;
  totalSteps: number;
  isAtStart: boolean;
  isAtEnd: boolean;

  // Auto-play interval
  autoPlayInterval: number | null;

  // Actions
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  stepForward: () => void;
  stepBackward: () => void;
  jumpToFirst: () => void;
  jumpToLast: () => void;
  jumpToStep: (index: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  setTotalSteps: (total: number) => void;
  enableLiveMode: () => void;
  disableLiveMode: () => void;
}

export const usePlaybackStore = create<PlaybackStore>()(
  subscribeWithSelector((set, get) => ({
    state: 'idle',
    speed: 1,
    currentStepIndex: 0,
    totalSteps: 0,
    isAtStart: true,
    isAtEnd: false,
    autoPlayInterval: null,

    play: () => {
      const { speed, totalSteps, currentStepIndex } = get();

      if (currentStepIndex >= totalSteps - 1) {
        // At end, restart from beginning
        set({
          currentStepIndex: 0,
          isAtStart: true,
          isAtEnd: totalSteps <= 1,
        });
      }

      // Clear any existing interval
      const existingInterval = get().autoPlayInterval;
      if (existingInterval) {
        window.clearInterval(existingInterval);
      }

      // Calculate interval based on speed (base 1000ms / speed)
      const intervalMs = 1000 / speed;

      const interval = window.setInterval(() => {
        const { currentStepIndex, totalSteps } = get();
        if (currentStepIndex < totalSteps - 1) {
          const newIndex = currentStepIndex + 1;
          set({
            currentStepIndex: newIndex,
            isAtStart: newIndex === 0,
            isAtEnd: newIndex >= totalSteps - 1,
          });
        } else {
          // Reached end, stop playing
          get().pause();
        }
      }, intervalMs);

      set({
        state: 'playing',
        autoPlayInterval: interval,
      });
    },

    pause: () => {
      const interval = get().autoPlayInterval;
      if (interval) {
        window.clearInterval(interval);
      }
      set({
        state: 'paused',
        autoPlayInterval: null,
      });
    },

    togglePlayPause: () => {
      const { state } = get();
      if (state === 'playing') {
        get().pause();
      } else {
        get().play();
      }
    },

    stepForward: () => {
      const { currentStepIndex, totalSteps } = get();
      if (currentStepIndex < totalSteps - 1) {
        const newIndex = currentStepIndex + 1;
        set({
          currentStepIndex: newIndex,
          isAtStart: newIndex === 0,
          isAtEnd: newIndex >= totalSteps - 1,
        });
      }
    },

    stepBackward: () => {
      const { currentStepIndex } = get();
      if (currentStepIndex > 0) {
        const newIndex = currentStepIndex - 1;
        set({
          currentStepIndex: newIndex,
          isAtStart: newIndex === 0,
          isAtEnd: newIndex >= get().totalSteps - 1,
        });
      }
    },

    jumpToFirst: () => {
      set({
        currentStepIndex: 0,
        isAtStart: true,
        isAtEnd: get().totalSteps <= 1,
      });
    },

    jumpToLast: () => {
      const { totalSteps } = get();
      const lastIndex = Math.max(0, totalSteps - 1);
      set({
        currentStepIndex: lastIndex,
        isAtStart: lastIndex === 0,
        isAtEnd: true,
      });
    },

    jumpToStep: (index: number) => {
      const { totalSteps } = get();
      const clampedIndex = Math.max(0, Math.min(index, totalSteps - 1));
      set({
        currentStepIndex: clampedIndex,
        isAtStart: clampedIndex === 0,
        isAtEnd: clampedIndex >= totalSteps - 1,
      });
    },

    setSpeed: (speed: PlaybackSpeed) => {
      set({
        speed,
      });
      // If playing, restart with new speed
      const { state } = get();
      if (state === 'playing') {
        get().pause();
        get().play();
      }
    },

    setTotalSteps: (total: number) => {
      const { currentStepIndex } = get();
      set({
        totalSteps: total,
        isAtStart: currentStepIndex === 0,
        isAtEnd: currentStepIndex >= total - 1,
      });
    },

    enableLiveMode: () => {
      const interval = get().autoPlayInterval;
      if (interval) {
        window.clearInterval(interval);
      }
      set({
        state: 'live',
        autoPlayInterval: null,
      });
    },

    disableLiveMode: () => {
      set({
        state: 'idle',
      });
    },
  })),
);

// Selector hooks for performance
export const usePlaybackState = () => usePlaybackStore((state) => state.state);
export const usePlaybackSpeed = () => usePlaybackStore((state) => state.speed);
export const useCurrentStepIndex = () => usePlaybackStore((state) => state.currentStepIndex);
export const useTotalSteps = () => usePlaybackStore((state) => state.totalSteps);
export const useIsAtStart = () => usePlaybackStore((state) => state.isAtStart);
export const useIsAtEnd = () => usePlaybackStore((state) => state.isAtEnd);
