/**
 * Tests for the Debugger class
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { Debugger } from '../src/runtime/debugger';
import type { ServerMessage } from '../src/runtime/types';

describe('Debugger', () => {
  let events: ServerMessage[];
  let onEvent: (msg: ServerMessage) => void;

  beforeEach(() => {
    events = [];
    onEvent = (msg: ServerMessage) => {
      events.push(msg);
    };
  });

  describe('constructor', () => {
    it('defaults to autoStart: true', () => {
      const dbg = new Debugger({}, onEvent);
      // isAttached starts true from constructor
      expect(dbg.isAttached).toBe(true);
      expect(dbg.isPaused).toBe(false);
    });

    it('accepts initial breakpoints as strings', () => {
      const dbg = new Debugger(
        {
          breakpoints: [
            'step-a',
            'step-b',
          ],
        },
        onEvent,
      );
      expect(dbg.breakpoints).toHaveLength(2);
      expect(dbg.breakpoints[0].stepId).toBe('step-a');
      expect(dbg.breakpoints[1].stepId).toBe('step-b');
    });

    it('accepts initial breakpoints as objects', () => {
      const dbg = new Debugger(
        {
          breakpoints: [
            {
              stepId: 'step-c',
              condition: 'x > 1',
            },
          ],
        },
        onEvent,
      );
      expect(dbg.breakpoints).toHaveLength(1);
      expect(dbg.breakpoints[0].stepId).toBe('step-c');
      expect(dbg.breakpoints[0].condition).toBe('x > 1');
    });
  });

  describe('startRun()', () => {
    it('emits execution.start with agentId', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', {
        prompt: 'hello',
      });

      expect(events).toHaveLength(1);
      const msg = events[0];
      expect(msg.type).toBe('execution.start');
      if (msg.type === 'execution.start') {
        expect(msg.agentId).toBe('agent-1');
        expect(msg.trace).toBeDefined();
        expect(msg.trace.traceId).toBe('run-1');
      }
    });

    it('sets currentRun with correct fields', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', 'test-input');

      const run = dbg.currentRun;
      expect(run).not.toBeNull();
      expect(run!.id).toBe('run-1');
      expect(run!.agentId).toBe('agent-1');
      expect(run!.status).toBe('running');
      expect(run!.isLive).toBe(true);
      expect(run!.input).toBe('test-input');
    });

    it('keeps isAttached true after startRun', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      expect(dbg.isAttached).toBe(true);
    });
  });

  describe('autoStart: false', () => {
    it('starts paused when autoStart is false', () => {
      const dbg = new Debugger(
        {
          autoStart: false,
        },
        onEvent,
      );
      dbg.startRun('agent-1', 'run-1', null);
      expect(dbg.isPaused).toBe(true);
    });

    it('does not start paused when autoStart is true (default)', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      expect(dbg.isPaused).toBe(false);
    });
  });

  describe('addBreakpoint() / removeBreakpoint()', () => {
    it('adds a string breakpoint', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.addBreakpoint('my-step');
      expect(dbg.breakpoints).toHaveLength(1);
      expect(dbg.breakpoints[0].stepId).toBe('my-step');
    });

    it('adds an object breakpoint', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.addBreakpoint({
        stepId: 'step-x',
        condition: 'attempt > 2',
      });
      expect(dbg.breakpoints).toHaveLength(1);
      expect(dbg.breakpoints[0].stepId).toBe('step-x');
      expect(dbg.breakpoints[0].condition).toBe('attempt > 2');
    });

    it('removes a breakpoint by stepId', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.addBreakpoint('step-a');
      dbg.addBreakpoint('step-b');
      expect(dbg.breakpoints).toHaveLength(2);

      dbg.removeBreakpoint('step-a');
      expect(dbg.breakpoints).toHaveLength(1);
      expect(dbg.breakpoints[0].stepId).toBe('step-b');
    });

    it('removing non-existent breakpoint is a no-op', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.addBreakpoint('step-a');
      dbg.removeBreakpoint('step-nonexistent');
      expect(dbg.breakpoints).toHaveLength(1);
    });

    it('breakpoints getter returns a copy', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.addBreakpoint('step-a');
      const bps = dbg.breakpoints;
      bps.push({
        stepId: 'injected',
      });
      expect(dbg.breakpoints).toHaveLength(1);
    });
  });

  describe('pause() / resume()', () => {
    it('pause sets isPaused to true', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      expect(dbg.isPaused).toBe(false);

      dbg.pause();
      expect(dbg.isPaused).toBe(true);
    });

    it('resume clears isPaused', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      dbg.pause();
      expect(dbg.isPaused).toBe(true);

      dbg.resume();
      expect(dbg.isPaused).toBe(false);
    });

    it('pause is idempotent', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.pause();
      dbg.pause();
      expect(dbg.isPaused).toBe(true);
    });

    it('resume is idempotent', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.resume();
      dbg.resume();
      expect(dbg.isPaused).toBe(false);
    });
  });

  describe('endRun()', () => {
    it('sets isAttached to false after endRun', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      expect(dbg.isAttached).toBe(true);

      dbg.endRun('completed');
      expect(dbg.isAttached).toBe(false);
    });

    it('emits execution.complete for completed status', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      events = []; // clear start event

      dbg.endRun('completed');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('execution.complete');
    });

    it('emits execution.error for error status', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      events = [];

      dbg.endRun('error');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('execution.error');
    });

    it('emits execution.error for cancelled status', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      events = [];

      dbg.endRun('cancelled');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('execution.error');
    });

    it('defaults to completed when no argument', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      events = [];

      dbg.endRun();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('execution.complete');
    });

    it('updates run status and timing', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.startRun('agent-1', 'run-1', null);
      dbg.endRun('completed');

      const run = dbg.currentRun;
      expect(run).not.toBeNull();
      expect(run!.status).toBe('completed');
      expect(run!.endTime).toBeGreaterThan(0);
      expect(run!.durationMs).toBeGreaterThanOrEqual(0);
      expect(run!.isLive).toBe(false);
    });

    it('is a no-op if no run started', () => {
      const dbg = new Debugger({}, onEvent);
      dbg.endRun('completed');
      expect(events).toHaveLength(0);
    });
  });

  describe('pauseHistory', () => {
    it('returns a copy of pause history', () => {
      const dbg = new Debugger({}, onEvent);
      const history = dbg.pauseHistory;
      expect(history).toEqual([]);
    });
  });

  describe('without onEvent callback', () => {
    it('does not throw when emitting without callback', () => {
      const dbg = new Debugger({});
      dbg.startRun('agent-1', 'run-1', null);
      dbg.endRun('completed');
      // No error should be thrown
    });
  });
});
