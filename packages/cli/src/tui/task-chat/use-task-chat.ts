/**
 * React hook that drives a `TaskChatView` against a running task agent.
 *
 * Connects to the runner's per-task IPC socket (`agent-ipc-server.ts`),
 * pulls history + the live item / event streams, and exposes the same
 * shape the in-process chat hook does so the same `ResponsesChat`
 * component can render either source.
 */

import type { StreamingItem } from '@noetic/core';
import { ItemSchema } from '@noetic/core';
import { useEffect, useRef, useState } from 'react';

import { AgentIpcClient } from '../../commands/builtins/tasks/agent-ipc-client.js';
import type { ConversationEntry } from '../item-utils.js';
import { appendOrUpdateEntry } from '../item-utils.js';

//#region Types

export type TaskChatStatus =
  | {
      readonly kind: 'connecting';
    }
  | {
      readonly kind: 'ready';
    }
  | {
      readonly kind: 'streaming';
    }
  | {
      readonly kind: 'submitted';
    }
  | {
      readonly kind: 'closed';
      readonly reason: string;
    };

export interface TaskChatHandle {
  /** Conversation entries to feed into ResponsesChat. */
  readonly entries: ReadonlyArray<ConversationEntry>;
  readonly status: TaskChatStatus;
  /** Server-issued connection metadata (taskId / role / runnerId / threadId). */
  readonly hello: {
    readonly taskId: string;
    readonly role: string;
    readonly runnerId: string;
    readonly threadId: string;
  } | null;
  /** Submit a user message; resolves once the runner acks it. */
  send(text: string): Promise<void>;
  /** Disconnect from the runner socket. */
  close(): void;
}

export interface UseTaskChatOpts {
  /** Absolute path to the runner's unix-domain socket. */
  readonly socketPath: string;
}

//#endregion

//#region Helpers

function parseStreamingItem(value: unknown): StreamingItem | null {
  const result = ItemSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  return {
    ...result.data,
    isComplete: extractIsComplete(value),
  };
}

/**
 * Read `isComplete` off a wire payload without an `as` cast. The harness
 * side emits `StreamingItem`, which is `Item & { isComplete: boolean }`,
 * but `ItemSchema` doesn't carry the flag, so we recover it from the
 * untyped raw object. Defaults to `true` (treat as final) when the flag
 * is missing — that's the right default for history replay.
 */
function extractIsComplete(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  if (!('isComplete' in value)) {
    return true;
  }
  return Boolean(value.isComplete);
}

function newRandomId(): string {
  // crypto.randomUUID is available in Bun and Node ≥18.
  return `m-${crypto.randomUUID()}`;
}

//#endregion

//#region Public hook

export function useTaskChat(opts: UseTaskChatOpts): TaskChatHandle {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [status, setStatus] = useState<TaskChatStatus>({
    kind: 'connecting',
  });
  const [hello, setHello] = useState<TaskChatHandle['hello']>(null);
  const clientRef = useRef<AgentIpcClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = new AgentIpcClient({
      socketPath: opts.socketPath,
    });
    clientRef.current = client;

    const itemPump = async (stream: AsyncIterable<unknown>): Promise<void> => {
      try {
        for await (const raw of stream) {
          if (cancelled) {
            return;
          }
          const item = parseStreamingItem(raw);
          if (item === null) {
            continue;
          }
          // Re-check cancelled after the parse — the await above can
          // resolve into a state where the component already unmounted
          // and we'd otherwise call setState on a dead component.
          if (cancelled) {
            return;
          }
          setEntries((prev) => appendOrUpdateEntry(prev, item));
        }
      } catch {
        // Stream closed — handled via socket close below.
      }
    };

    void (async (): Promise<void> => {
      try {
        const info = await client.connect();
        if (cancelled) {
          client.close();
          return;
        }
        setHello(info);
        const history = await client.getHistory();
        if (cancelled) {
          return;
        }
        for (const raw of history) {
          const item = parseStreamingItem(raw);
          if (item === null) {
            continue;
          }
          setEntries((prev) => appendOrUpdateEntry(prev, item));
        }
        const streams = client.subscribe();
        // Ensure subscribe was processed before we expect items to flow
        // (round-trip a status request).
        await client.getStatus();
        if (cancelled) {
          return;
        }
        setStatus({
          kind: 'ready',
        });
        void itemPump(streams.items);
      } catch (err) {
        if (cancelled) {
          return;
        }
        const reason = err instanceof Error ? err.message : 'connect failed';
        setStatus({
          kind: 'closed',
          reason,
        });
      }
    })();

    return () => {
      cancelled = true;
      const c = clientRef.current;
      clientRef.current = null;
      c?.close();
    };
  }, [
    opts.socketPath,
  ]);

  const send = async (text: string): Promise<void> => {
    const client = clientRef.current;
    if (client === null) {
      throw new Error('useTaskChat: not connected');
    }
    const messageId = newRandomId();
    setEntries((prev) => [
      ...prev,
      {
        role: 'user',
        content: text,
        id: messageId,
        deliveryStatus: 'sent',
      },
    ]);
    setStatus({
      kind: 'submitted',
    });
    try {
      await client.send({
        messageId,
        text,
      });
      setStatus({
        kind: 'streaming',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'send failed';
      setStatus({
        kind: 'closed',
        reason,
      });
      throw err;
    }
  };

  const close = (): void => {
    clientRef.current?.close();
    clientRef.current = null;
  };

  return {
    entries,
    status,
    hello,
    send,
    close,
  };
}

//#endregion
