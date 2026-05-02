/**
 * Wire protocol for the per-task agent IPC socket.
 *
 * Newline-delimited JSON. One frame per line. The frame envelope is strictly
 * validated by Zod on both ends; the inner `item` / `event` payloads are
 * passed through as `unknown` because the core `Item` / `StreamEvent` types
 * are open-ended tagged unions whose extension shapes the protocol layer
 * doesn't own. Consumers cast to the core types — both sides of the socket
 * share the same `@noetic/core` version, so the wire encoding is a faithful
 * JSON round-trip of those types.
 */

import { z } from 'zod';

//#region Constants

/** Wire protocol version. Bumped when frame shapes change incompatibly. */
export const PROTOCOL_VERSION = 1;

//#endregion

//#region Client → Server frames

const SubscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
});

const GetHistoryFrameSchema = z.object({
  type: z.literal('getHistory'),
});

const SendFrameSchema = z.object({
  type: z.literal('send'),
  messageId: z.string().min(1),
  text: z.string().min(1),
});

const GetStatusFrameSchema = z.object({
  type: z.literal('getStatus'),
});

const AbortFrameSchema = z.object({
  type: z.literal('abort'),
  reason: z.string().optional(),
});

export const ClientFrameSchema = z.discriminatedUnion('type', [
  SubscribeFrameSchema,
  GetHistoryFrameSchema,
  SendFrameSchema,
  GetStatusFrameSchema,
  AbortFrameSchema,
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;

//#endregion

//#region Server → Client frames

const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  role: z.string().min(1),
  runnerId: z.string().min(1),
  threadId: z.string().min(1),
});

const HistoryFrameSchema = z.object({
  type: z.literal('history'),
  items: z.array(z.unknown()),
});

const ItemFrameSchema = z.object({
  type: z.literal('item'),
  item: z.unknown(),
});

const EventFrameSchema = z.object({
  type: z.literal('event'),
  event: z.unknown(),
});

const StatusFrameSchema = z.object({
  type: z.literal('status'),
  status: z.unknown(),
});

const AckFrameSchema = z.object({
  type: z.literal('ack'),
  messageId: z.string().min(1),
});

const ErrorFrameSchema = z.object({
  type: z.literal('error'),
  error: z.object({
    kind: z.string().min(1),
    message: z.string().min(1),
  }),
});

const ByeFrameSchema = z.object({
  type: z.literal('bye'),
  reason: z.string().optional(),
});

export const ServerFrameSchema = z.discriminatedUnion('type', [
  HelloFrameSchema,
  HistoryFrameSchema,
  ItemFrameSchema,
  EventFrameSchema,
  StatusFrameSchema,
  AckFrameSchema,
  ErrorFrameSchema,
  ByeFrameSchema,
]);

export type ServerFrame = z.infer<typeof ServerFrameSchema>;

//#endregion

//#region Codec helpers

/**
 * Encode a frame for the wire. Always terminates with `\n` so a peer's
 * line-buffered reader can split on newlines without needing a length prefix.
 */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parse a single line into a typed client frame. Throws ZodError on mismatch. */
export function parseClientFrame(line: string): ClientFrame {
  return ClientFrameSchema.parse(JSON.parse(line));
}

/** Parse a single line into a typed server frame. Throws ZodError on mismatch. */
export function parseServerFrame(line: string): ServerFrame {
  return ServerFrameSchema.parse(JSON.parse(line));
}

//#endregion
