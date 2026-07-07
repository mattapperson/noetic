/**
 * The wire protocol spoken between a Noetic agent and an OpenUI client. The
 * server translates the harness's `getFullStream()` events (SDK `response.*`
 * plus framework `openui.*`) into a line-delivery protocol the client renders
 * progressively, and ingests client interactions back as `ui-event` items.
 *
 * These are pure functions so the translation is unit-testable without a live
 * harness or socket.
 */

import type { StreamEvent } from '@noetic-tools/types';
import { z } from 'zod';
import { serializeDocument } from '../lang/document';
import type { OpenUiSurfaceState } from '../layer/surface';

//#region Message model

/** @public Zod schema validating an {@link OpenUiServerMessage} on the wire. */
export const OpenUiServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    source: z.string(),
    vars: z.record(z.string(), z.unknown()),
    version: z.number(),
  }),
  z.object({
    type: z.literal('statement'),
    ref: z.string(),
    kind: z.string(),
    source: z.string(),
  }),
  z.object({
    type: z.literal('fragment'),
    callId: z.string().optional(),
    dialect: z.string(),
    source: z.string(),
  }),
  z.object({
    type: z.literal('text'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('done'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
]);

/** @public A message the server sends to the client. */
export type OpenUiServerMessage =
  | {
      type: 'snapshot';
      /** Full OpenUI Lang source of the current document (for rehydration). */
      source: string;
      vars: Record<string, unknown>;
      version: number;
    }
  | {
      type: 'statement';
      ref: string;
      kind: string;
      /** OpenUI Lang source of the single completed statement. */
      source: string;
    }
  | {
      type: 'fragment';
      /** The tool call this fragment belongs to, if tool-authored. */
      callId?: string;
      dialect: string;
      source: string;
    }
  | {
      type: 'text';
      delta: string;
    }
  | {
      type: 'done';
    }
  | {
      type: 'error';
      message: string;
    };

/** The protocol identifier advertised to clients. */
export const OPENUI_PROTOCOL = 'noetic-openui/1';

//#endregion

//#region Server → client translation

function frameworkSuffix(agentName: string, type: string): string | null {
  const prefix = `${agentName}:`;
  return type.startsWith(prefix) ? type.slice(prefix.length) : null;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Translate one harness stream event into a client message, or null when the
 * event carries nothing the UI renders (reasoning, tool bookkeeping, …).
 * @public
 */
export function translateStreamEvent(
  event: StreamEvent,
  agentName: string,
): OpenUiServerMessage | null {
  if (event.source === 'framework') {
    const suffix = frameworkSuffix(agentName, event.type);
    if (suffix === 'openui.node' || suffix === 'openui.state' || suffix === 'openui.query') {
      return {
        type: 'statement',
        ref: stringField(event.data, 'ref'),
        kind: stringField(event.data, 'kind'),
        source: stringField(event.data, 'source'),
      };
    }
    if (suffix === 'openui.fragment') {
      const callId = event.data.callId;
      return {
        type: 'fragment',
        ...(typeof callId === 'string'
          ? {
              callId,
            }
          : {}),
        dialect: stringField(event.data, 'dialect'),
        source: stringField(event.data, 'source'),
      };
    }
    return null;
  }
  if (event.type === 'response.completed') {
    return {
      type: 'done',
    };
  }
  if (event.type === 'error') {
    return {
      type: 'error',
      message: stringField(event.data, 'message') || 'stream error',
    };
  }
  return null;
}

/** Build the reconnect snapshot message from current surface state. */
export function snapshotMessage(state: OpenUiSurfaceState): Extract<
  OpenUiServerMessage,
  {
    type: 'snapshot';
  }
> {
  return {
    type: 'snapshot',
    source: serializeDocument(state.document),
    vars: state.vars,
    version: state.version,
  };
}

//#endregion

//#region SSE framing

/** Encode a message as one SSE `data:` frame. */
export function encodeSseFrame(message: OpenUiServerMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

//#endregion
