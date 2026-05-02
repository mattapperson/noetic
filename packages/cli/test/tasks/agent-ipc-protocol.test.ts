import { describe, expect, it } from 'bun:test';
import { ZodError } from 'zod';
import type {
  ClientFrame,
  ServerFrame,
} from '../../src/commands/builtins/tasks/agent-ipc-protocol.js';
import {
  ClientFrameSchema,
  encodeFrame,
  PROTOCOL_VERSION,
  parseClientFrame,
  parseServerFrame,
  ServerFrameSchema,
} from '../../src/commands/builtins/tasks/agent-ipc-protocol.js';

describe('agent-ipc-protocol', () => {
  describe('client frames', () => {
    it('round-trips a subscribe frame', () => {
      const frame: ClientFrame = {
        type: 'subscribe',
      };
      const wire = encodeFrame(frame);
      expect(wire.endsWith('\n')).toBe(true);
      const parsed = parseClientFrame(wire.trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips a getHistory frame', () => {
      const frame: ClientFrame = {
        type: 'getHistory',
      };
      const parsed = parseClientFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips a send frame', () => {
      const frame: ClientFrame = {
        type: 'send',
        messageId: 'm1',
        text: 'hello',
      };
      const parsed = parseClientFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips a getStatus frame', () => {
      const frame: ClientFrame = {
        type: 'getStatus',
      };
      const parsed = parseClientFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips an abort frame with a reason', () => {
      const frame: ClientFrame = {
        type: 'abort',
        reason: 'user-cancelled',
      };
      const parsed = parseClientFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips an abort frame without a reason', () => {
      const frame: ClientFrame = {
        type: 'abort',
      };
      const parsed = parseClientFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('rejects an unknown frame type', () => {
      expect(() =>
        parseClientFrame(
          JSON.stringify({
            type: 'noSuchFrame',
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects a send frame with an empty text', () => {
      expect(() =>
        parseClientFrame(
          JSON.stringify({
            type: 'send',
            messageId: 'm1',
            text: '',
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects a send frame with an empty messageId', () => {
      expect(() =>
        parseClientFrame(
          JSON.stringify({
            type: 'send',
            messageId: '',
            text: 'hi',
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects malformed JSON', () => {
      expect(() => parseClientFrame('not json')).toThrow();
    });
  });

  describe('server frames', () => {
    it('round-trips a hello frame', () => {
      const frame: ServerFrame = {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        taskId: 'T-1',
        role: 'planner',
        runnerId: 'planner',
        threadId: 't',
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips a history frame with arbitrary item payloads', () => {
      const frame: ServerFrame = {
        type: 'history',
        items: [
          {
            id: 'm1',
            type: 'message',
            role: 'user',
          },
          {
            id: 'm2',
            type: 'function_call',
          },
        ],
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips an item frame', () => {
      const frame: ServerFrame = {
        type: 'item',
        item: {
          id: 'm1',
          type: 'message',
          isComplete: true,
        },
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips an event frame', () => {
      const frame: ServerFrame = {
        type: 'event',
        event: {
          source: 'framework',
          type: 'noetic-cli:turn_started',
          data: {
            turnId: 't1',
          },
        },
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips a status frame', () => {
      const frame: ServerFrame = {
        type: 'status',
        status: {
          kind: 'idle',
        },
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips an ack frame', () => {
      const frame: ServerFrame = {
        type: 'ack',
        messageId: 'm1',
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips an error frame', () => {
      const frame: ServerFrame = {
        type: 'error',
        error: {
          kind: 'invalid_frame',
          message: 'bad frame',
        },
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('round-trips a bye frame', () => {
      const frame: ServerFrame = {
        type: 'bye',
      };
      const parsed = parseServerFrame(encodeFrame(frame).trim());
      expect(parsed).toEqual(frame);
    });

    it('rejects an error frame with empty kind', () => {
      expect(() =>
        parseServerFrame(
          JSON.stringify({
            type: 'error',
            error: {
              kind: '',
              message: 'x',
            },
          }),
        ),
      ).toThrow(ZodError);
    });
  });

  describe('schemas are exported and usable directly', () => {
    it('ClientFrameSchema parses without throwing on a valid value', () => {
      const result = ClientFrameSchema.safeParse({
        type: 'subscribe',
      });
      expect(result.success).toBe(true);
    });

    it('ServerFrameSchema parses without throwing on a valid value', () => {
      const result = ServerFrameSchema.safeParse({
        type: 'ack',
        messageId: 'm1',
      });
      expect(result.success).toBe(true);
    });
  });
});
