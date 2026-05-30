/**
 * React hook that drives a `TaskChatView` against a running task agent.
 *
 * Connects to the runner's per-task IPC socket (`agent-ipc-server.ts`),
 * pulls history + the live item / event streams, and exposes the same
 * shape the in-process chat hook does so the same `ResponsesChat`
 * component can render either source. Also surfaces any pending
 * ask-user request the runner has issued (via `pendingAskUser` /
 * `submitAskUser` / `cancelAskUser`) so the TUI can render the modal.
 */

import type { AskUserPendingFrame, AskUserStreamEvent } from '@noetic-tools/platform-node';
import { AgentIpcClient } from '@noetic-tools/platform-node';
import type { AskUserOutput, StreamingItem } from '@noetic-tools/core';
import { ItemSchema } from '@noetic-tools/core';
import { useEffect, useRef, useState } from 'react';
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
  /**
   * Currently-pending ask-user request issued by the runner agent, or
   * `null` if none. Set when an `askUserRequest` frame arrives;
   * cleared when the matching `askUserCleared` frame arrives or when
   * the user submits/cancels the modal locally.
   */
  readonly pendingAskUser: AskUserPendingFrame | null;
  /** Submit a user message; resolves once the runner acks it. */
  send(text: string): Promise<void>;
  /** Answer the currently-pending ask-user request. */
  submitAskUser(output: AskUserOutput): void;
  /** Dismiss the currently-pending ask-user request. */
  cancelAskUser(reason?: string): void;
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
  const [pendingAskUser, setPendingAskUser] = useState<AskUserPendingFrame | null>(null);
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

    const askUserPump = async (stream: AsyncIterable<AskUserStreamEvent>): Promise<void> => {
      try {
        for await (const evt of stream) {
          if (cancelled) {
            return;
          }
          if (evt.kind === 'pending') {
            setPendingAskUser(evt.request);
            continue;
          }
          // Cleared. Drop the pending question if its id matches — a
          // mismatched id means another client answered a different
          // question (shouldn't happen with a single-pending design,
          // but harmless if it ever does).
          setPendingAskUser((prev) => (prev !== null && prev.id === evt.id ? null : prev));
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
        void askUserPump(streams.askUser);
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

  const submitAskUser = (output: AskUserOutput): void => {
    const client = clientRef.current;
    if (client === null) {
      return;
    }
    if (pendingAskUser === null) {
      return;
    }
    const id = pendingAskUser.id;
    // Optimistically clear the modal — the server will broadcast an
    // `askUserCleared` echoing this anyway, but waiting for the round
    // trip would leave the modal visible for a flicker.
    setPendingAskUser(null);
    client.resolveAskUser(id, output);
  };

  const cancelAskUser = (reason?: string): void => {
    const client = clientRef.current;
    if (client === null) {
      return;
    }
    if (pendingAskUser === null) {
      return;
    }
    const id = pendingAskUser.id;
    setPendingAskUser(null);
    client.cancelAskUser(id, reason);
  };

  const close = (): void => {
    clientRef.current?.close();
    clientRef.current = null;
  };

  return {
    entries,
    status,
    hello,
    pendingAskUser,
    send,
    submitAskUser,
    cancelAskUser,
    close,
  };
}

//#endregion
