/**
 * Tests for usePlaybackStore
 * Covers transport controls, state management, and boundary conditions
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { PlaybackSpeed } from '../src/client/stores/playbackStore';
import { usePlaybackStore } from '../src/client/stores/playbackStore';

// Bun's test environment does not expose `window`. The store uses
// `window.setInterval` / `window.clearInterval`, so we alias globalThis here.
if (typeof window === 'undefined') {
  Object.assign(globalThis, {
    window: {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    },
  });
}

function resetStore(): void {
  const { pause } = usePlaybackStore.getState();
  pause(); // clear any active interval
  usePlaybackStore.setState({
    state: 'idle',
    speed: 1,
    currentStepIndex: 0,
    totalSteps: 0,
    isAtStart: true,
    isAtEnd: false,
    autoPlayInterval: null,
  });
}

beforeEach(() => {
  resetStore();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('has the correct default values', () => {
    const s = usePlaybackStore.getState();
    expect(s.state).toBe('idle');
    expect(s.speed).toBe(1);
    expect(s.currentStepIndex).toBe(0);
    expect(s.totalSteps).toBe(0);
    expect(s.isAtStart).toBe(true);
    expect(s.isAtEnd).toBe(false);
    expect(s.autoPlayInterval).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setTotalSteps
// ---------------------------------------------------------------------------

describe('setTotalSteps', () => {
  it('updates totalSteps', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    expect(usePlaybackStore.getState().totalSteps).toBe(5);
  });

  it('sets isAtEnd=true when currentStepIndex is at the last position', () => {
    usePlaybackStore.setState({
      currentStepIndex: 4,
    });
    usePlaybackStore.getState().setTotalSteps(5);
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });

  it('sets isAtEnd=false when currentStepIndex is not at the last position', () => {
    usePlaybackStore.setState({
      currentStepIndex: 2,
    });
    usePlaybackStore.getState().setTotalSteps(5);
    expect(usePlaybackStore.getState().isAtEnd).toBe(false);
  });

  it('sets isAtStart=true when currentStepIndex is 0', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
  });

  it('sets isAtStart=false when currentStepIndex is not 0', () => {
    usePlaybackStore.setState({
      currentStepIndex: 2,
    });
    usePlaybackStore.getState().setTotalSteps(5);
    expect(usePlaybackStore.getState().isAtStart).toBe(false);
  });

  it('marks isAtEnd=true when totalSteps is 1 and currentStepIndex is 0', () => {
    usePlaybackStore.getState().setTotalSteps(1);
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stepForward
// ---------------------------------------------------------------------------

describe('stepForward', () => {
  it('increments currentStepIndex', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.getState().stepForward();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(1);
  });

  it('sets isAtStart=false after moving off index 0', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.getState().stepForward();
    expect(usePlaybackStore.getState().isAtStart).toBe(false);
  });

  it('sets isAtEnd=true when reaching the last step', () => {
    usePlaybackStore.getState().setTotalSteps(2);
    usePlaybackStore.getState().stepForward();
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });

  it('does not increment beyond the last step (no-op at end)', () => {
    usePlaybackStore.getState().setTotalSteps(2);
    usePlaybackStore.getState().stepForward(); // index 1
    usePlaybackStore.getState().stepForward(); // should no-op
    expect(usePlaybackStore.getState().currentStepIndex).toBe(1);
  });

  it('does not move when totalSteps is 0', () => {
    usePlaybackStore.getState().stepForward();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stepBackward
// ---------------------------------------------------------------------------

describe('stepBackward', () => {
  it('decrements currentStepIndex', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.setState({
      currentStepIndex: 2,
      isAtStart: false,
      isAtEnd: true,
    });
    usePlaybackStore.getState().stepBackward();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(1);
  });

  it('sets isAtEnd=false after stepping back from the last step', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.setState({
      currentStepIndex: 2,
      isAtStart: false,
      isAtEnd: true,
    });
    usePlaybackStore.getState().stepBackward();
    expect(usePlaybackStore.getState().isAtEnd).toBe(false);
  });

  it('sets isAtStart=true when reaching index 0', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.setState({
      currentStepIndex: 1,
      isAtStart: false,
      isAtEnd: false,
    });
    usePlaybackStore.getState().stepBackward();
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
  });

  it('does not decrement below 0 (no-op at start)', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.getState().stepBackward();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jumpToFirst
// ---------------------------------------------------------------------------

describe('jumpToFirst', () => {
  it('sets currentStepIndex to 0', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.setState({
      currentStepIndex: 3,
    });
    usePlaybackStore.getState().jumpToFirst();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(0);
  });

  it('sets isAtStart=true', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.setState({
      currentStepIndex: 3,
      isAtStart: false,
    });
    usePlaybackStore.getState().jumpToFirst();
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
  });

  it('sets isAtEnd=false when totalSteps > 1', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.setState({
      currentStepIndex: 4,
      isAtEnd: true,
    });
    usePlaybackStore.getState().jumpToFirst();
    expect(usePlaybackStore.getState().isAtEnd).toBe(false);
  });

  it('sets isAtEnd=true when totalSteps is 1', () => {
    usePlaybackStore.getState().setTotalSteps(1);
    usePlaybackStore.getState().jumpToFirst();
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jumpToLast
// ---------------------------------------------------------------------------

describe('jumpToLast', () => {
  it('sets currentStepIndex to totalSteps-1', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToLast();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(4);
  });

  it('sets isAtEnd=true', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToLast();
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });

  it('sets isAtStart=false when totalSteps > 1', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToLast();
    expect(usePlaybackStore.getState().isAtStart).toBe(false);
  });

  it('sets isAtStart=true when totalSteps is 1', () => {
    usePlaybackStore.getState().setTotalSteps(1);
    usePlaybackStore.getState().jumpToLast();
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
  });

  it('clamps to 0 when totalSteps is 0', () => {
    usePlaybackStore.getState().jumpToLast();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jumpToStep
// ---------------------------------------------------------------------------

describe('jumpToStep', () => {
  it('sets currentStepIndex to the given index', () => {
    usePlaybackStore.getState().setTotalSteps(10);
    usePlaybackStore.getState().jumpToStep(5);
    expect(usePlaybackStore.getState().currentStepIndex).toBe(5);
  });

  it('clamps index below 0 to 0', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToStep(-3);
    expect(usePlaybackStore.getState().currentStepIndex).toBe(0);
  });

  it('clamps index above totalSteps-1 to totalSteps-1', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToStep(99);
    expect(usePlaybackStore.getState().currentStepIndex).toBe(4);
  });

  it('sets isAtStart=true when jumping to 0', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.setState({
      currentStepIndex: 3,
      isAtStart: false,
    });
    usePlaybackStore.getState().jumpToStep(0);
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
  });

  it('sets isAtStart=false when jumping to a non-zero index', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToStep(2);
    expect(usePlaybackStore.getState().isAtStart).toBe(false);
  });

  it('sets isAtEnd=true when jumping to the last index', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToStep(4);
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });

  it('sets isAtEnd=false when jumping to a non-last index', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToStep(2);
    expect(usePlaybackStore.getState().isAtEnd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// play
// ---------------------------------------------------------------------------

describe('play', () => {
  it('sets state to playing', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    expect(usePlaybackStore.getState().state).toBe('playing');
    usePlaybackStore.getState().pause();
  });

  it('sets autoPlayInterval to a non-null value', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    expect(usePlaybackStore.getState().autoPlayInterval).not.toBeNull();
    usePlaybackStore.getState().pause();
  });

  it('restarts from index 0 when already at the end', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.setState({
      currentStepIndex: 2,
      isAtEnd: true,
    });
    usePlaybackStore.getState().play();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(0);
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
    usePlaybackStore.getState().pause();
  });

  it('does not restart from 0 when not at the end', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.setState({
      currentStepIndex: 2,
      isAtStart: false,
      isAtEnd: false,
    });
    usePlaybackStore.getState().play();
    expect(usePlaybackStore.getState().currentStepIndex).toBe(2);
    usePlaybackStore.getState().pause();
  });
});

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

describe('pause', () => {
  it('sets state to paused', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().state).toBe('paused');
  });

  it('clears autoPlayInterval', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().autoPlayInterval).toBeNull();
  });

  it('can be called when already paused without error', () => {
    usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().state).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// togglePlayPause
// ---------------------------------------------------------------------------

describe('togglePlayPause', () => {
  it('starts playing when idle', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().togglePlayPause();
    expect(usePlaybackStore.getState().state).toBe('playing');
    usePlaybackStore.getState().pause();
  });

  it('pauses when playing', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().togglePlayPause();
    expect(usePlaybackStore.getState().state).toBe('paused');
  });

  it('resumes playing when paused', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().pause();
    usePlaybackStore.getState().togglePlayPause();
    expect(usePlaybackStore.getState().state).toBe('playing');
    usePlaybackStore.getState().pause();
  });
});

// ---------------------------------------------------------------------------
// setSpeed
// ---------------------------------------------------------------------------

describe('setSpeed', () => {
  it('updates the speed', () => {
    const newSpeed: PlaybackSpeed = 2;
    usePlaybackStore.getState().setSpeed(newSpeed);
    expect(usePlaybackStore.getState().speed).toBe(2);
  });

  it('accepts all valid speed values', () => {
    const speeds: PlaybackSpeed[] = [
      1,
      2,
      5,
      10,
    ];
    for (const speed of speeds) {
      usePlaybackStore.getState().setSpeed(speed);
      expect(usePlaybackStore.getState().speed).toBe(speed);
    }
  });

  it('restarts playback when currently playing', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().setSpeed(2);
    // Should still be playing after the restart
    expect(usePlaybackStore.getState().state).toBe('playing');
    expect(usePlaybackStore.getState().autoPlayInterval).not.toBeNull();
    usePlaybackStore.getState().pause();
  });

  it('does not start playback when currently paused', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().pause();
    usePlaybackStore.getState().setSpeed(5);
    expect(usePlaybackStore.getState().state).toBe('paused');
    expect(usePlaybackStore.getState().autoPlayInterval).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enableLiveMode
// ---------------------------------------------------------------------------

describe('enableLiveMode', () => {
  it('sets state to live', () => {
    usePlaybackStore.getState().enableLiveMode();
    expect(usePlaybackStore.getState().state).toBe('live');
  });

  it('clears autoPlayInterval when transitioning from playing', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().enableLiveMode();
    expect(usePlaybackStore.getState().autoPlayInterval).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// disableLiveMode
// ---------------------------------------------------------------------------

describe('disableLiveMode', () => {
  it('sets state to idle', () => {
    usePlaybackStore.getState().enableLiveMode();
    usePlaybackStore.getState().disableLiveMode();
    expect(usePlaybackStore.getState().state).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Boundary: isAtStart / isAtEnd consistency
// ---------------------------------------------------------------------------

describe('isAtStart / isAtEnd boundary consistency', () => {
  it('isAtStart=true and isAtEnd=true for a single-step trace', () => {
    usePlaybackStore.getState().setTotalSteps(1);
    const { isAtStart, isAtEnd } = usePlaybackStore.getState();
    expect(isAtStart).toBe(true);
    expect(isAtEnd).toBe(true);
  });

  it('isAtStart=true and isAtEnd=false at the start of a multi-step trace', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    const { isAtStart, isAtEnd } = usePlaybackStore.getState();
    expect(isAtStart).toBe(true);
    expect(isAtEnd).toBe(false);
  });

  it('isAtStart=false and isAtEnd=true at the end of a multi-step trace', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToLast();
    const { isAtStart, isAtEnd } = usePlaybackStore.getState();
    expect(isAtStart).toBe(false);
    expect(isAtEnd).toBe(true);
  });

  it('isAtStart=false and isAtEnd=false in the middle of a trace', () => {
    usePlaybackStore.getState().setTotalSteps(5);
    usePlaybackStore.getState().jumpToStep(2);
    const { isAtStart, isAtEnd } = usePlaybackStore.getState();
    expect(isAtStart).toBe(false);
    expect(isAtEnd).toBe(false);
  });

  it('stepForward from second-to-last sets isAtEnd=true', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.getState().jumpToStep(1);
    usePlaybackStore.getState().stepForward();
    expect(usePlaybackStore.getState().isAtEnd).toBe(true);
  });

  it('stepBackward from index 1 sets isAtStart=true', () => {
    usePlaybackStore.getState().setTotalSteps(3);
    usePlaybackStore.getState().jumpToStep(1);
    usePlaybackStore.getState().stepBackward();
    expect(usePlaybackStore.getState().isAtStart).toBe(true);
  });
});
