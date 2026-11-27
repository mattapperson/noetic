/**
 * The flow stored with a turn (spec 23 § Versions): the source of the flow a turn
 * began under, kept under the turn's execution, so a harness running a newer flow
 * can build the old one again and resume the turn on it.
 */

import type { FlowRebuildFailure, Step, StorageAdapter } from '@noetic-tools/types';
import { FlowRebuildReason, frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import type { FlowSource } from '../builders/flow-source';
import { flowFrom, flowSourceOf } from '../builders/flow-source';
import { flowVersionOf } from './flow-version';

//#region Types

const StoredFlowSchema = z.object({
  /** The version the flow runs as: the harness's `version`, or the hash. */
  version: z.string(),
  /** The hash of every source in the flow's step tree, whatever its version is called. */
  hash: z.string(),
  /** The source of the flow's root step, as `flowFrom` was given it. */
  source: z.unknown(),
});

/** A flow as a turn stores it. */
export type StoredFlow = z.infer<typeof StoredFlowSchema>;

/** A flow a turn can run. */
export interface TurnFlow {
  readonly graph: Step | undefined;
  /** The version the turn records under. */
  readonly version: string | undefined;
  /** What the turn stores of it. Undefined for a flow with no source. */
  readonly stored: StoredFlow | undefined;
}

//#endregion

//#region Stored flows

export class StoredFlows {
  /** The harness's own flow. */
  readonly own: TurnFlow;
  private readonly build: FlowSource['build'] | undefined;
  /** Flows rebuilt in this process, by hash and version: a flow is built once. */
  private readonly rebuilt = new Map<string, Step>();

  constructor(
    private readonly storage: StorageAdapter | undefined,
    graph: Step | undefined,
    version: string | undefined,
  ) {
    const flow = graph ? flowSourceOf(graph) : undefined;
    // No hash: a source in the tree cannot be encoded, so it cannot be stored either.
    const hash = flowVersionOf(graph);
    this.build = flow?.build;
    this.own = {
      graph,
      version,
      stored:
        flow && hash !== undefined && storage
          ? {
              version: version ?? hash,
              hash,
              // Plain JSON, as storage would hand it back.
              source: JSON.parse(JSON.stringify(flow.source)),
            }
          : undefined,
    };
  }

  /**
   * Store `flow` for the turn on `executionId`. Resolves whether it is stored.
   * Best-effort: a turn whose flow could not be stored still runs, and resumes
   * under a newer flow as one with no source.
   */
  async keep(executionId: string, flow: StoredFlow): Promise<boolean> {
    try {
      await this.storage?.set<StoredFlow>(flowKey(executionId), flow);
      return this.storage !== undefined;
    } catch (error) {
      console.warn(
        `AgentHarness: failed to store flow "${flow.version}" for execution "${executionId}":`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /** Delete the flow stored for `executionId`. Best-effort: a forget of the execution sweeps it. */
  async drop(executionId: string): Promise<void> {
    await this.storage?.delete(flowKey(executionId)).catch(() => undefined);
  }

  /**
   * Rebuild the source pinned by the turn's version and hash. Resolves
   * undefined when the turn stored none, and a failure when this harness
   * cannot run what the turn stored.
   */
  async rebuild(
    executionId: string,
    version: string,
    hash: string,
  ): Promise<TurnFlow | FlowRebuildFailure | undefined> {
    const raw = await this.storage?.get<unknown>(flowKey(executionId));
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const fail = (reason: FlowRebuildReason, message: string): FlowRebuildFailure => ({
      version,
      reason,
      message,
    });
    const parsed = StoredFlowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.version !== version) {
      return fail(
        FlowRebuildReason.Unreadable,
        'What the turn stored is not the flow of its version.',
      );
    }
    const stored = parsed.data;
    if (stored.hash !== hash) {
      return fail(
        FlowRebuildReason.HashMismatch,
        `The stored flow hashes to ${stored.hash}, but the turn pinned ${hash}.`,
      );
    }
    const build = this.build;
    if (!build) {
      return fail(
        FlowRebuildReason.NoBuilder,
        'The harness has no builder: its agentGraph is not a JSON workflow.',
      );
    }
    const cacheKey = `${stored.hash}\n${version}`;
    let graph = this.rebuilt.get(cacheKey);
    if (!graph) {
      try {
        graph = frameworkCast<Step>(flowFrom(stored.source, build));
      } catch (error) {
        return fail(
          FlowRebuildReason.BuildFailed,
          error instanceof Error ? error.message : String(error),
        );
      }
      // A tree that runs a document the stored source does not hold is another flow.
      const builtHash = flowVersionOf(graph);
      if (builtHash !== stored.hash) {
        return fail(
          FlowRebuildReason.HashMismatch,
          `The rebuilt flow hashes to ${builtHash ?? 'nothing'}, not the stored ${stored.hash}.`,
        );
      }
      this.rebuilt.set(cacheKey, graph);
    }
    return {
      graph,
      version,
      stored,
    };
  }
}

/** Whether `rebuilt` is a failure rather than a flow. */
export function isRebuildFailure(
  rebuilt: TurnFlow | FlowRebuildFailure | undefined,
): rebuilt is FlowRebuildFailure {
  return rebuilt !== undefined && 'reason' in rebuilt;
}

/** The key the turn on `executionId` stores its flow under. */
export function flowKey(executionId: string): string {
  return `execution:${executionId}:flow`;
}

//#endregion
