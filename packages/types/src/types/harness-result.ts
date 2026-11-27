import type { LastLayerUsage } from './context-parts/layer-usage';
import type { HeldCall } from './harness-judgment';
import type { Item } from './items';

//#region Stream Event Types

/** @public SDK-originated event from the OpenResponses streaming API. */
export interface SdkStreamEvent {
  readonly source: 'sdk';
  /** OpenResponses SSE event type string (e.g., 'response.output_text.delta'). */
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly outputIndex?: number;
  readonly contentIndex?: number;
  /** The nested agent this event belongs to; absent for the run's own output. */
  readonly scope?: AgentScope;
}

/**
 * @public A nested agent an event belongs to: an agent step's subagent (spec 08
 * § Nested agents). The run's own output carries none, and the text, reasoning and
 * item streams leave scoped events out; the full stream keeps them.
 */
export interface AgentScope {
  /** Unique within the execution; stable for the agent's life. */
  readonly id: string;
  /** The nested agent that started this one; absent when the step's own agent did. */
  readonly parentId?: string;
  /** What the agent that started it calls it (`Explore`, `worker`). */
  readonly title?: string;
}

/** @public Framework-originated event, prefixed with the harness config.name. */
export interface FrameworkStreamEvent {
  readonly source: 'framework';
  /** Prefixed event type (e.g., 'myagent:step_started'). */
  readonly type: `${string}:${string}`;
  readonly data: Record<string, unknown>;
  /** The nested agent this event belongs to; absent for the run's own events. */
  readonly scope?: AgentScope;
}

/** @public Union of all stream event types emitted during execution. */
export type StreamEvent = SdkStreamEvent | FrameworkStreamEvent;

//#endregion

//#region Harness Response

/**
 * @public
 * Why a turn was cut (spec 23 § Cut turns). A later wake can resume the turn
 * using its recorded progress or the original external execution.
 */
export type TurnCutReason =
  | 'lease_lost'
  | 'ledger_write_failed'
  | 'acp_link_lost'
  | 'connection_outcome_unknown';

/** @public A turn that was cut rather than failed: a later wake runs it again from its record. */
export interface TurnCut {
  readonly reason: TurnCutReason;
  /**
   * How many times a failed write has cut this turn, this one included. Absent for
   * `lease_lost`: the turn is another holder's, and this harness counts nothing.
   */
  readonly attempt?: number;
  /**
   * Epoch ms from which a routine `harness.wake()` runs it again: after its back-off,
   * or, for `lease_lost`, once the other holder's lease runs out.
   */
  readonly wakeAt: number;
}

/** @public Final accumulated result of an execution, including all items, usage, cost, and extracted text.
 *
 *  Returned from `AgentHarness.getAgentResponse()`. Resolves once the session's
 *  message queue drains and the runner goes idle. When multiple turns run in a
 *  burst (e.g. queued inbox messages), the response covers the span from the
 *  last-idle point through the point at which idle is reached again.
 */
export interface HarnessResponse<TItem = Item> {
  /** Final items only: standard items plus each declared custom item's final form (spec 34). */
  readonly items: ReadonlyArray<TItem>;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /**
     * Prompt tokens served from the provider's cache across the turns this
     * response covers. `undefined` — not `0` — while no model call has reported
     * a cache figure, preserving the `RoundUsage` distinction between "nothing
     * was cached" and "this provider says nothing about caching".
     */
    readonly cachedTokens?: number;
  };
  /** USD the turn's work cost, including steps and rounds replayed from a recorded run. */
  readonly cost?: number;
  /** USD the turn actually paid — `cost` less what replay supplied. See `Context.billedCost`. */
  readonly billedCost?: number;
  /** USD held for the turn's paid calls that have no settled bill yet. See `Context.heldCost`. */
  readonly heldCost?: number;
  readonly text: string;
  /**
   * Set when the turn parked instead of finishing: every part of it is waiting, and
   * no process holds it. `wakeAt` is the earliest deadline among its waits, in epoch
   * ms. `harness.wake()` resumes it, as does a decision for a held call, passed to `harness.execute()`. `text` is empty and `items` are those so far.
   */
  readonly parked?: {
    /** Absent when nothing the turn waits on has a deadline, such as a held tool call. */
    readonly wakeAt?: number;
  };
  /**
   * Set when the turn was cut instead of failing (spec 23 § Cut turns): its lease was
   * lost or a durable write failed, and it runs again from its record at `wakeAt`.
   * `text` is empty and `items` are those so far.
   */
  readonly cut?: TurnCut;
  /**
   * Set when the message was delivered before and its turn had already finished:
   * this is that turn's recorded answer, and nothing ran. `items` is the thread's
   * history.
   */
  readonly replayed?: boolean;
  /**
   * The tool calls a parked turn holds for a person, as `harness.pending()` lists
   * them. Present with `parked` when there are any; a decision item passed to `harness.execute()` answers one.
   */
  readonly held?: ReadonlyArray<HeldCall>;
  /** Per-context-layer context window breakdown captured at the last callModel of this execution. */
  readonly lastLayerUsage?: LastLayerUsage;
}

//#endregion

//#region Streaming Item

/** @public An Item snapshot with a completion flag, emitted from getItemStream(). */
export type StreamingItem = Item & {
  readonly isComplete: boolean;
};

//#endregion
