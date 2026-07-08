/**
 * Talks the noetic OpenUI transport protocol (`noetic-openui/1`). The server
 * streams the surface as Server-Sent Events; each `data:` line is one of these
 * messages. This is the same frame vocabulary `serveOpenUi` emits — we just
 * consume it in the browser, validating each frame at the boundary with Zod.
 */

import { z } from 'zod';

//#region Protocol messages (mirror of @noetic-tools/openui/server protocol)

const ServerMessageSchema = z.discriminatedUnion('type', [
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

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export interface UiEvent {
  kind: 'set' | 'submit' | 'action' | 'toAssistant';
  ref: string;
  payload?: unknown;
  seq: number;
  version?: number;
}

const ENDPOINT = '/agent';

//#endregion

//#region Frame parsing

function parseDataLine(line: string): ServerMessage | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = ServerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

//#endregion

//#region Public API

/** POST a prompt and stream every frame to `onMessage` until `done`. */
export async function runTurn(
  prompt: string,
  onMessage: (msg: ServerMessage) => void,
): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
    }),
  });
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('no response stream');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {
      stream: true,
    });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const msg = parseDataLine(frame);
      if (msg) {
        onMessage(msg);
      }
    }
  }
}

/** Send a client interaction back into the agent's surface (202, no body). */
export async function sendEvent(event: UiEvent): Promise<void> {
  await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event,
    }),
  });
}

/** Fetch the current surface snapshot (used on first load / reconnect). */
export async function fetchSnapshot(): Promise<ServerMessage | null> {
  const res = await fetch(ENDPOINT, {
    method: 'GET',
  });
  const parsed = ServerMessageSchema.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

//#endregion
