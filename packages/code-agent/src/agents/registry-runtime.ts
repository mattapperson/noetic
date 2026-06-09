/**
 * In-process registry tracking spawned teammates (sub-agents) for the CLI.
 *
 * One registry per `AgentHarness`. Holds:
 *   - `handlesById`: every detached handle the parent has launched
 *   - `teammatesByName`: addressable teammates with a per-name `inbox` queue
 *     (`string[]`) consumed by the child via `teammateInboundLayer`
 *   - `parentNotices`: queue of completion / failure messages drained by
 *     `teammateInboxLayer` at the parent's turn start
 *
 * Both queues are plain arrays (not `Channel<T>`) because memory-layer hooks
 * receive `ExecutionContext`, which has no `tryRecv`. Composes only existing
 * `@noetic-tools/core` types — `DetachedHandle` for handle reference, no new core
 * concept.
 */

import type { DetachedHandle } from '@noetic-tools/core';

//#region Types

/**
 * Bundle of references for an addressable (named) teammate.
 *
 * `inbox` is a FIFO queue of messages written by `sendMessage` and drained
 * by `teammateInboundLayer` at the child's next recall.
 */
interface NamedTeammate {
  handle: DetachedHandle<string>;
  inbox: string[];
}

//#endregion

//#region TeammateRegistry

/**
 * Per-harness registry of running teammates. Constructed once in
 * `createAgentHarness` and injected into the `agent` / `sendMessage` /
 * `checkAgent` tools and the inbox-drain memory layers.
 */
export class TeammateRegistry {
  private readonly handlesById = new Map<string, DetachedHandle<string>>();
  private readonly teammatesByName = new Map<string, NamedTeammate>();
  private readonly parentNotices: string[] = [];

  /** Push a completion / failure notice for the parent's next turn to surface. */
  postNotice(message: string): void {
    this.parentNotices.push(message);
  }

  /** Drain all queued notices in FIFO order. Returns an empty array when empty. */
  drainNotices(): string[] {
    if (this.parentNotices.length === 0) {
      return [];
    }
    return this.parentNotices.splice(0, this.parentNotices.length);
  }

  /**
   * Append a message to a named teammate's inbound queue. Returns `false` if
   * no teammate with that name is registered (caller should surface as
   * `unknown_teammate`).
   */
  postInbound(name: string, message: string): boolean {
    const teammate = this.teammatesByName.get(name);
    if (teammate === undefined) {
      return false;
    }
    teammate.inbox.push(message);
    return true;
  }

  /**
   * Drain a teammate's inbound queue in FIFO order. Returns empty array when
   * unknown or empty. Used by `teammateInboundLayer` on each child recall.
   */
  drainInbound(name: string): string[] {
    const teammate = this.teammatesByName.get(name);
    if (teammate === undefined || teammate.inbox.length === 0) {
      return [];
    }
    return teammate.inbox.splice(0, teammate.inbox.length);
  }

  registerById(handle: DetachedHandle<string>): void {
    this.handlesById.set(handle.id, handle);
  }

  registerByName(name: string, teammate: NamedTeammate): void {
    this.handlesById.set(teammate.handle.id, teammate.handle);
    this.teammatesByName.set(name, teammate);
  }

  getById(agentId: string): DetachedHandle<string> | undefined {
    return this.handlesById.get(agentId);
  }

  getByName(name: string): NamedTeammate | undefined {
    return this.teammatesByName.get(name);
  }

  /** Remove all references to a single teammate. Safe to call if it was never registered. */
  unregister(agentId: string): void {
    this.handlesById.delete(agentId);
    for (const [name, teammate] of this.teammatesByName) {
      if (teammate.handle.id === agentId) {
        this.teammatesByName.delete(name);
      }
    }
  }

  /**
   * Drop the registry's references to all teammates and clear queues.
   *
   * **Important:** this does NOT abort in-flight teammate executions —
   * `DetachedHandle` exposes no cancel API. The child execution continues
   * until it settles or the process exits. Settle notices it posts after
   * this call land in this (now-empty) registry; consumers using a
   * `WeakRef` to this registry will silently observe the registry was
   * dropped and skip the post.
   *
   * Wired into `tui/app.tsx:invalidateHarness` so /model, /clear, and
   * session restart release strong references for GC.
   */
  dropAll(): void {
    this.handlesById.clear();
    this.teammatesByName.clear();
    this.parentNotices.length = 0;
  }

  listIds(): ReadonlyArray<string> {
    return [
      ...this.handlesById.keys(),
    ];
  }

  listNames(): ReadonlyArray<string> {
    return [
      ...this.teammatesByName.keys(),
    ];
  }
}

//#endregion

export type { NamedTeammate };
