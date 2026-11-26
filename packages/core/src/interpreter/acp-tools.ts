/**
 * Runs Noetic tools on an ACP agent's behalf.
 *
 * The agent reaches the tools over MCP; each call it makes lands here and runs
 * through the same pipeline as a `callModel` tool call — the drain hold, the
 * `beforeToolCall` layers, validation, `needsApproval`, execution, the result
 * item, its events and span — so the agent's model sees exactly the string a
 * model would, and the host sees the same record.
 */

import type {
  AcpSessionNotification,
  AcpTool,
  AcpToolCall,
  AcpToolHost,
  AcpToolResult,
  AgentScope,
  Context,
  ContextData,
  ContextLayer,
  FunctionCallItem,
  Item,
  ItemSchemaRegistry,
  StepAcpAgent,
  Tool,
  ToolCallPresentation,
  ToolIdentity,
} from '@noetic-tools/types';
import {
  bridgedToolTitles,
  defaultItemSchemaRegistry,
  frameworkCast,
  identifyToolCall,
  namesBridgedToolCall,
  presentToolCall,
  presentToolContent,
} from '@noetic-tools/types';
import {
  ACP_TOOL_SERVER_NAME,
  acpDelegateStepOf,
  checkedAcpTools,
} from '../builders/acp-agent-checks';
import { orderedCallId } from '../connections/durability';
import type { SplitStepTools } from '../connections/step-tools';
import { offeredTools, stepConnectionsOf } from '../connections/step-tools';
import { ToolAttr } from '../observability/genai-attributes';
import { drainsOf } from '../runtime/drain';
import {
  heldCallsOf,
  heldScopeOf,
  mayWriteHolds,
  noticeHeld,
  toHeldCall,
  waitOnHeldCalls,
} from '../runtime/held-calls';
import type { ToolProgressReport } from '../runtime/tool-call';
import { createToolResultItem, executeToolCall, resolveWireJsonSchema } from '../runtime/tool-call';
import { sanitizeToolNameForWire } from '../util/tool-name';
import type { AcpEventBridge } from './acp-events';
import type { BridgedCallRecord } from './acp-resume';
import { BridgedCallRecords } from './acp-resume';
import { resolveLazy, resolveToolsAndRestrictions, splitResolvedTools } from './action-tools';
import { openChildSpan, traceChild } from './child-span';
import { deduplicateTools } from './collect-tools';
import { isFunctionCall } from './typeguards';

//#region Types

/** The step a bridged call runs in. Rebound before each turn. */
export interface AcpToolBinding {
  stepId: string;
  ctx: Context<ContextData>;
  layers?: ContextLayer[];
  events: AcpEventBridge;
  /**
   * Called when the pipeline itself throws — not the tool, whose errors are
   * results. A `callModel` step fails on such an error, so the turn must too.
   */
  fail: (error: unknown) => void;
}

/** One call's binding: where it reports as it runs. */
interface CallBinding extends AcpToolBinding {
  /**
   * Nobody had announced the call when it started while a subagent was about:
   * its item and lifecycle wait until its owner is known, so all of it lands
   * on one stream.
   */
  provisional: boolean;
  /** The nested agent making it, when known to be a subagent's as it starts. */
  scope?: AgentScope;
  /** The step's own events: held calls are announced there, never scoped. */
  stepEvents: AcpEventBridge;
}

/** One finished bridged call: the pair of items it adds to the log. */
interface BridgedCall {
  readonly wireName: string;
  readonly callItem: FunctionCallItem;
  readonly outputItem: Item;
}

type SessionUpdate = AcpSessionNotification['update'];

//#endregion

//#region Constants

/** MCP requires an object at the root of every input schema. */
const WRAPPED_ARG = 'value';

/**
 * An agent announces a call over ACP and makes it over MCP; the two arrive on
 * different connections. A call that beats its announcement waits this long
 * for it, so its events and items carry the agent's id.
 */
const ANNOUNCEMENT_GRACE_MS = 50;

const CANCELLED_OUTPUT = 'Error: the step was cancelled before this tool call ran.';

//#endregion

//#region Listing

/**
 * An object root, which MCP and the providers behind agents accept as is.
 * A root union is not one: Anthropic rejects `oneOf`/`anyOf`/`allOf` at the
 * top of a tool schema, so a union is wrapped like any other root.
 */
function isObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === 'object' &&
    schema.oneOf === undefined &&
    schema.anyOf === undefined &&
    schema.allOf === undefined
  );
}

/** A `$ref` into the old root, pointed at where the schema now sits. */
function rehomeRef(ref: string): string {
  if (!ref.startsWith('#') || ref.startsWith('#/definitions') || ref.startsWith('#/$defs')) {
    return ref;
  }
  return `#/properties/${WRAPPED_ARG}${ref.slice(1)}`;
}

function rehomeRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rehomeRefs);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === '$ref' && typeof nested === 'string' ? rehomeRef(nested) : rehomeRefs(nested),
    ]),
  );
}

/**
 * A schema with a non-object root, carried as the one property `value`. Its
 * definitions move to the new root and refs into the old root follow it, so
 * every `$ref` still resolves.
 */
function wrapSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, definitions, $defs, ...inner } = schema;
  return {
    ...(definitions !== undefined
      ? {
          definitions,
        }
      : {}),
    ...($defs !== undefined
      ? {
          $defs,
        }
      : {}),
    type: 'object',
    properties: {
      [WRAPPED_ARG]: rehomeRefs(inner),
    },
    required: [
      WRAPPED_ARG,
    ],
    additionalProperties: false,
  };
}

function titleOf(tool: Tool): string | undefined {
  const title = (tool.presentation ?? tool.acp)?.title;
  return typeof title === 'string' ? title : undefined;
}

//#endregion

//#region Item merge

function isOutputFor(item: Item, callId: string): boolean {
  return item.type === 'function_call_output' && item.callId === callId;
}

/** The agent's own record of a call it made through the bridge, by its title or id. */
function namesBridgedCall(item: FunctionCallItem, wireName: string): boolean {
  return namesBridgedToolCall(ACP_TOOL_SERVER_NAME, wireName, {
    toolCallId: item.callId,
    title: item.name,
  });
}

/**
 * Replace the agent's account of each bridged call with the bridge's own pair,
 * in the agent's place in the turn. The pair keeps the bridge's `callId` — the
 * one its events and approval saw — and joins the agent's record by that id,
 * or else by the first unclaimed exact title. A call the agent never reported
 * is appended.
 */
export function mergeBridgedItems(
  items: ReadonlyArray<Item>,
  calls: ReadonlyArray<BridgedCall>,
): {
  items: Item[];
} {
  // Only the agent's own records are matched — never a pair this merge added —
  // exact ids before titles, each record claimed once.
  const slotOf = matchBridgedCalls(items, calls);
  const byRecord = new Map<string, BridgedCall>();
  for (const [call, index] of slotOf) {
    const record = items[index];
    if (!record || !isFunctionCall(record)) {
      continue;
    }
    byRecord.set(record.callId, call);
  }
  const merged: Item[] = [];
  const placedOutput = new Set<string>();
  for (const item of items) {
    if (isFunctionCall(item) && byRecord.has(item.callId)) {
      const call = byRecord.get(item.callId);
      if (call) {
        merged.push(call.callItem);
        if (!items.some((other) => isOutputFor(other, item.callId))) {
          merged.push(call.outputItem);
          placedOutput.add(item.callId);
        }
      }
      continue;
    }
    const replacing = [
      ...byRecord.entries(),
    ].find(([recordId]) => isOutputFor(item, recordId));
    if (replacing && !placedOutput.has(replacing[0])) {
      merged.push(replacing[1].outputItem);
      placedOutput.add(replacing[0]);
      continue;
    }
    merged.push(item);
  }
  for (const call of calls) {
    if (!slotOf.has(call)) {
      merged.push(call.callItem, call.outputItem);
    }
  }
  return {
    items: merged,
  };
}

/**
 * Which of the agent's own records each bridged call stands for: by exact id
 * first, then by the first unclaimed record whose title names its tool. A
 * call with no record is absent.
 */
function matchBridgedCalls(
  items: ReadonlyArray<Item>,
  calls: ReadonlyArray<BridgedCall>,
): Map<BridgedCall, number> {
  const slotOf = new Map<BridgedCall, number>();
  const claimed = new Set<number>();
  const claim = (call: BridgedCall, match: (item: FunctionCallItem) => boolean): void => {
    const index = items.findIndex(
      (item, at) => !claimed.has(at) && isFunctionCall(item) && match(item),
    );
    if (index >= 0) {
      claimed.add(index);
      slotOf.set(call, index);
    }
  };
  for (const call of calls) {
    claim(call, (item) => item.callId === call.callItem.callId);
  }
  for (const call of calls) {
    if (!slotOf.has(call)) {
      claim(call, (item) => namesBridgedCall(item, call.wireName));
    }
  }
  return slotOf;
}

//#endregion

/** Who announced a bridged call: the step's own agent, or a subagent. */
type CallOwner =
  | {
      kind: 'step';
    }
  | {
      kind: 'subagent';
      sessionId: string;
    };

/** What the turn knows of one of the agent's tool calls, by its id. */
interface KnownCall {
  /** The title its announcement gave. */
  title?: string;
  /** Who announced it; the step's own announcement is final. */
  owner?: CallOwner;
  /** The record it is held under while it waits on a person. */
  heldAs?: string;
}

/** A finished call, in the order calls finished. */
interface SettledCall extends BridgedCall {
  readonly callId: string;
  /**
   * Set while the call's result item is not yet on the stream: published on
   * these step events, in queue order, when the turn's calls are taken.
   */
  readonly pending?: AcpEventBridge;
  /** Nobody had announced it: a subagent announcing it by the turn's end takes it. */
  readonly provisional?: boolean;
  /** A provisional call's start and completion, reported with its result once its owner is known. */
  readonly deferred?: {
    readonly args: unknown;
    readonly presentation: ToolCallPresentation;
    readonly identity: ToolIdentity;
    readonly completion: Record<string, unknown>;
  };
}

//#region Runner

/**
 * The tool host a connection serves. Calls run one at a time, in arrival
 * order — the `callModel` tool loop never runs two at once, and agents that
 * call in parallel would otherwise race on shared state.
 */
export class AcpToolRunner implements AcpToolHost {
  readonly serverName = ACP_TOOL_SERVER_NAME;
  readonly tools: ReadonlyArray<AcpTool>;
  private readonly byWireName: ReadonlyMap<string, Tool>;
  private readonly wrapped: ReadonlySet<string>;
  private binding: AcpToolBinding | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private finished: SettledCall[] = [];
  private round = 0;
  /** Set when a call's pipeline threw: the turn is failing, so no further call runs. */
  private failed = false;
  /** The turn's tool calls the runner has heard of: announced, or held. */
  private readonly calls = new Map<string, KnownCall>();
  /** The one call waiting for its announcement (calls run one at a time). */
  private waiter:
    | {
        callId: string;
        wake: () => void;
      }
    | undefined;
  /** Set once a subagent is heard from this turn: calls may then be theirs. */
  private subagentsThisTurn = false;
  /** Ids already given to a call this session; an agent may not reuse one. */
  private readonly claimed = new Set<string>();
  /** What each call recorded, so a resumed step replays it (spec 27 § Resuming a step). */
  private readonly records = new BridgedCallRecords();

  constructor(private readonly source: ReadonlyArray<Tool>) {
    const wrapped = new Set<string>();
    this.tools = source.map((tool) => {
      const name = sanitizeToolNameForWire(tool.name);
      const schema = resolveWireJsonSchema({
        schema: tool.input,
        explicitJsonSchema: tool.inputJsonSchema,
        what: `input schema of tool '${tool.name}'`,
      });
      if (!isObjectSchema(schema)) {
        wrapped.add(name);
      }
      return {
        name,
        description: tool.description,
        inputSchema: isObjectSchema(schema) ? schema : wrapSchema(schema),
        title: titleOf(tool),
      };
    });
    this.wrapped = wrapped;
    this.byWireName = new Map(
      source.map((tool) => [
        sanitizeToolNameForWire(tool.name),
        tool,
      ]),
    );
  }

  /** Point the runner at the step whose turn is about to start. */
  bind(binding: AcpToolBinding): void {
    this.binding = binding;
    this.round = 0;
    this.failed = false;
    this.subagentsThisTurn = false;
    // A new turn: what the last one announced is settled, its leftovers taken.
    this.calls.clear();
  }

  /** Stop running calls: the turn they belonged to has ended. */
  unbind(): void {
    this.binding = undefined;
  }

  /**
   * Settles once no call is queued or running. An agent may end its turn
   * while a call it gave up on still runs; that call still belongs to the
   * turn, as an in-flight `callModel` call belongs to its aborted round.
   */
  async idle(): Promise<void> {
    let settled: Promise<unknown>;
    do {
      settled = this.queue;
      await settled;
    } while (settled !== this.queue);
  }

  /** The agent's session was reloaded: see `BridgedCallRecords.sessionReloaded`. */
  sessionReloaded(): void {
    this.records.sessionReloaded();
  }

  /**
   * Which tool a call to `wireName` with `input` is to, as the bridge would
   * identify it running the call (spec 08 § Tool calls): one announced but
   * never run groups with the ones that ran.
   */
  identityOf(wireName: string, input: unknown): ToolIdentity {
    const tool = this.byWireName.get(wireName);
    return tool
      ? identifyToolCall(tool, input)
      : {
          id: wireName,
        };
  }

  /** The tool's wire name when `title` is how an agent titles a call to it. */
  wireNameOf(title: string): string | undefined {
    return this.tools.find((tool) => bridgedToolTitles(this.serverName, tool.name).includes(title))
      ?.name;
  }

  private known(callId: string): KnownCall {
    const existing = this.calls.get(callId);
    if (existing) {
      return existing;
    }
    const created: KnownCall = {};
    this.calls.set(callId, created);
    return created;
  }

  /** Note an agent `tool_call`, so a call without an id in `_meta` can take its id. */
  observe(update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call') {
      return;
    }
    const call = this.known(update.toolCallId);
    call.title = update.title;
    // The step's own announcement places a call; no subagent's can take it after.
    call.owner = {
      kind: 'step',
    };
    this.wake(update.toolCallId);
  }

  /**
   * Note a subagent's update. Its `tool_call` makes a bridged call it makes its
   * nested agent's — its events go there, and it stays out of the step's items.
   */
  observeChild(sessionId: string, update: SessionUpdate): void {
    this.subagentsThisTurn = true;
    if (update.sessionUpdate !== 'tool_call') {
      return;
    }
    const call = this.known(update.toolCallId);
    call.title = update.title;
    if (call.owner?.kind !== 'step') {
      call.owner = {
        kind: 'subagent',
        sessionId,
      };
      this.renameAsker(call, sessionId);
    }
    this.wake(update.toolCallId);
  }

  /** A call already held for a person turns out to be a subagent's: the hold names it. */
  private renameAsker(call: KnownCall, sessionId: string): void {
    const binding = this.binding;
    if (call.heldAs === undefined || !binding || !mayWriteHolds(binding.ctx)) {
      return;
    }
    const scope = binding.events.scopeFor(sessionId);
    void heldCallsOf(binding.ctx.harness)
      .rescope(heldScopeOf(binding.ctx), call.heldAs, scope)
      .catch(() => undefined);
  }

  private wake(callId: string): void {
    if (this.waiter?.callId === callId) {
      this.waiter.wake();
    }
  }

  /**
   * Who made a call, settled before it runs; undefined while nobody has
   * announced it. The MCP request names no session, so a call is placed by the
   * `tool_call` that announced it. Once a subagent has spoken this turn, a call
   * nobody has announced yet first waits a moment for its announcement.
   */
  private async ownerOf(callId: string): Promise<CallOwner | undefined> {
    const known = this.calls.get(callId)?.owner;
    if (known || !this.subagentsThisTurn) {
      return known;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiter = undefined;
        resolve();
      };
      const timer = setTimeout(done, ANNOUNCEMENT_GRACE_MS);
      this.waiter = {
        callId,
        wake: done,
      };
    });
    return this.calls.get(callId)?.owner;
  }

  /** The binding a call reports through: its subagent's nested agent, or the step's. */
  private bindingFor(binding: AcpToolBinding, owner: CallOwner | undefined): CallBinding {
    const child =
      owner?.kind === 'subagent' ? binding.events.childBridge(owner.sessionId) : undefined;
    const scope = owner?.kind === 'subagent' ? binding.events.scopeFor(owner.sessionId) : undefined;
    return {
      ...binding,
      ...(child
        ? {
            events: child,
          }
        : {}),
      ...(scope
        ? {
            scope,
          }
        : {}),
      stepEvents: binding.events,
      provisional: owner === undefined && this.subagentsThisTurn,
    };
  }

  /**
   * The calls finished since the last take, in the order they ran. A call run
   * provisionally as the step's is settled now: a subagent that announced it
   * since takes it — its result item goes to that nested agent, never the
   * step's items — and otherwise it is the step's.
   */
  takeFinished(): BridgedCall[] {
    const taken: BridgedCall[] = [];
    for (const call of this.finished) {
      const owner = call.provisional ? this.calls.get(call.callId)?.owner : undefined;
      if (owner?.kind === 'subagent') {
        const child = call.pending?.childBridge(owner.sessionId) ?? call.pending;
        if (child) {
          emitResult(child, call);
        }
        continue;
      }
      if (call.pending) {
        emitResult(call.pending, call);
      }
      taken.push(call);
    }
    this.finished = [];
    return taken;
  }

  /**
   * Put a finished call's result item where it belongs, read from who has
   * announced the call by now. One queue, in the order calls finished: a
   * subagent's goes to its nested agent; one nobody announced while a subagent
   * has spoken this turn waits for the turn's end, and any step result after
   * it waits behind it, so the stream keeps the order calls finished.
   */
  private publish(
    binding: CallBinding,
    finished: Omit<SettledCall, 'pending' | 'provisional'>,
  ): void {
    const known = this.known(finished.callId);
    const owner = known.owner;
    if (owner?.kind === 'subagent') {
      emitResult(binding.stepEvents.childBridge(owner.sessionId) ?? binding.events, finished);
      return;
    }
    const provisional = owner === undefined && this.subagentsThisTurn;
    if (owner === undefined && !provisional) {
      // With no subagent about, an unannounced call is the step's for good.
      known.owner = {
        kind: 'step',
      };
    }
    const behind = provisional || this.finished.some((settled) => settled.pending !== undefined);
    this.finished.push({
      ...finished,
      ...(provisional
        ? {
            provisional,
          }
        : {}),
      ...(behind
        ? {
            pending: binding.stepEvents,
          }
        : {}),
    });
    if (!behind) {
      emitResult(binding.stepEvents, finished);
    }
  }

  readonly call = (call: AcpToolCall): Promise<AcpToolResult> => {
    const next = this.queue.then(() => this.run(call));
    this.queue = next.catch(() => undefined);
    return next;
  };

  private async run(call: AcpToolCall): Promise<AcpToolResult> {
    const binding = this.binding;
    if (!binding) {
      return {
        output: `Error: unknown tool '${call.name}'`,
        isError: true,
      };
    }
    await drainsOf(binding.ctx)?.hold(binding.ctx);
    if (call.agentCallId !== undefined && this.claimed.has(call.agentCallId)) {
      return {
        output: `Error: tool call id '${call.agentCallId}' was already used in this session.`,
        isError: true,
      };
    }
    const callId = await this.callIdFor(binding, call);
    // Like the `callModel` loop, which starts no call once its step is aborted
    // or a call's pipeline has thrown. Checked after every wait.
    if (this.failed || binding.ctx.aborted || call.signal.aborted) {
      return {
        output: CANCELLED_OUTPUT,
        isError: true,
      };
    }
    const owner = await this.ownerOf(callId);
    // Waiting for its owner was a wait too: nothing starts once the call is off.
    if (this.failed || binding.ctx.aborted || call.signal.aborted) {
      return {
        output: CANCELLED_OUTPUT,
        isError: true,
      };
    }
    try {
      return await this.runInRound(this.bindingFor(binding, owner), call, callId);
    } catch (e) {
      this.failed = true;
      if (this.binding === binding) {
        binding.fail(e);
      }
      return {
        output: `Error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }

  private async runInRound(
    binding: CallBinding,
    call: AcpToolCall,
    callId: string,
  ): Promise<AcpToolResult> {
    const round = this.round;
    this.round += 1;
    binding.events.toolEvent('tool_round_started', {
      round,
      toolCount: 1,
    });
    const tool = this.byWireName.get(call.name);
    const span = openChildSpan(binding.ctx, 'tool.call', binding.stepId);
    span.setAttribute(ToolAttr.NAME, call.name);
    span.setAttribute(ToolAttr.NEEDS_APPROVAL, tool?.needsApproval ?? false);
    const result = await traceChild(binding.ctx, span, async () => {
      const executed = await this.execute(binding, call, callId, tool);
      if (executed.approval !== undefined) {
        span.setAttribute(ToolAttr.APPROVAL, executed.approval);
      }
      return executed;
    });
    binding.events.toolEvent('tool_round_completed', {
      round,
      toolCount: 1,
    });
    return {
      output: result.output,
      isError: result.error === true,
    };
  }

  /**
   * The agent's own id for the call: from its MCP request when it sent one,
   * else from its matching announced `tool_call`, so events, approval, and
   * items all carry the id the agent's own records use. A call the agent never
   * named gets one from the step and its order, which a resumed step repeats.
   */
  private async callIdFor(binding: AcpToolBinding, call: AcpToolCall): Promise<string> {
    if (call.agentCallId !== undefined) {
      this.claimed.add(call.agentCallId);
      return call.agentCallId;
    }
    const announced =
      this.announcedId(call.name) ??
      (await new Promise<string | undefined>((resolve) =>
        setTimeout(() => resolve(this.announcedId(call.name)), ANNOUNCEMENT_GRACE_MS),
      ));
    const callId = announced ?? orderedCallId(this, binding.ctx, binding.stepId);
    this.claimed.add(callId);
    return callId;
  }

  private announcedId(wireName: string): string | undefined {
    for (const [id, { title }] of this.calls) {
      if (
        title !== undefined &&
        !this.claimed.has(id) &&
        namesBridgedToolCall(this.serverName, wireName, {
          toolCallId: id,
          title,
        })
      ) {
        return id;
      }
    }
    return undefined;
  }

  private unwrap(call: AcpToolCall): unknown {
    if (!this.wrapped.has(call.name)) {
      return call.args;
    }
    if (typeof call.args !== 'object' || call.args === null) {
      return undefined;
    }
    return Reflect.get(call.args, WRAPPED_ARG);
  }

  /**
   * Run the call to a result. A call held for a person waits here, with the agent
   * waiting on it: the turn stays live, since the agent's process is what holds its
   * place. The result is recorded before the call's intent or hold is dropped, so a
   * step cut off in between asks again rather than runs again.
   */
  private async settle(
    binding: CallBinding,
    record: BridgedCallRecord,
    call: {
      params: Parameters<typeof executeToolCall>[0];
      /** Aborted when the agent gives up on the call. */
      signal: AbortSignal;
    },
  ): ReturnType<typeof executeToolCall> {
    const { signal } = call;
    const callId = call.params.callId;
    try {
      return await this.settleHeld(binding, record, call, signal);
    } finally {
      // However the call ends, it is no longer waiting on a person.
      const known = callId === undefined ? undefined : this.calls.get(callId);
      if (known) {
        known.heldAs = undefined;
      }
    }
  }

  /**
   * The nested agent a call is now known to be from — read when each hold opens,
   * since an announcement can land while the call is running.
   */
  private latestScope(binding: CallBinding, callId: string | undefined): AgentScope | undefined {
    const owner = callId === undefined ? undefined : this.calls.get(callId)?.owner;
    return owner?.kind === 'subagent' ? binding.stepEvents.scopeFor(owner.sessionId) : undefined;
  }

  private async settleHeld(
    binding: CallBinding,
    record: BridgedCallRecord,
    call: {
      params: Parameters<typeof executeToolCall>[0];
      signal: AbortSignal;
    },
    signal: AbortSignal,
  ): ReturnType<typeof executeToolCall> {
    const { ctx } = binding;
    const params = {
      ...call.params,
    };
    const withLatestScope = (): Parameters<typeof executeToolCall>[0] => {
      const scope = this.latestScope(binding, params.callId);
      return scope
        ? {
            ...params,
            scope,
          }
        : params;
    };
    let result = await executeToolCall(withLatestScope());
    let announced: string | undefined;
    while (result.held !== undefined) {
      let held = result.held;
      // The call may have turned out to be a subagent's since its hold opened.
      const scope = this.latestScope(binding, params.callId);
      if (scope && held.scope?.id !== scope.id && mayWriteHolds(ctx)) {
        const renamed = await heldCallsOf(ctx.harness).rescope(
          heldScopeOf(ctx),
          held.callId,
          scope,
        );
        held = renamed ? toHeldCall(renamed) : held;
      }
      // Said once per question, under the id the agent's other events carry.
      if (announced !== held.reason) {
        announced = held.reason;
        // A held call is the run's to answer: announced on the step's events,
        // never scoped, naming the asker in its data (`HeldCall.scope`).
        binding.stepEvents.toolEvent('tool_call_held', {
          ...held,
          callId: params.callId ?? held.callId,
          heldAs: held.callId,
        });
        noticeHeld({
          harness: ctx.harness,
          ctx,
          held,
          emit: (settled) =>
            binding.stepEvents.toolEvent('tool_call_settled', {
              ...settled,
              callId: params.callId ?? settled.callId,
              heldAs: settled.callId,
            }),
        });
      }
      // While it waits, a subagent identified as its caller renames the asker.
      this.known(params.callId ?? held.callId).heldAs = held.callId;
      // The wait throws `cancelled` when the agent's signal ends it, as it does for
      // the turn's own abort: only the latter is the turn's to handle.
      const gaveUp = await waitOnHeldCalls({
        harness: ctx.harness,
        ctx,
        callIds: [
          held.callId,
        ],
        signal,
        park: false,
      }).then(
        () => signal.aborted,
        (error: unknown) => {
          if (signal.aborted) {
            return true;
          }
          throw error;
        },
      );
      // The agent stopped waiting for this call: nobody is left to give an answer to.
      if (gaveUp) {
        this.known(params.callId ?? held.callId).heldAs = undefined;
        if (mayWriteHolds(ctx)) {
          await heldCallsOf(ctx.harness).close(heldScopeOf(ctx), held.callId, 'cancelled');
        }
        return {
          output: CANCELLED_OUTPUT,
          error: true,
        };
      }
      result = await executeToolCall(withLatestScope());
    }
    const stored = await record.store(result);
    if (!mayWriteHolds(ctx)) {
      return result;
    }
    const holds = heldCallsOf(ctx.harness);
    if (result.armed && stored) {
      await holds.disarm(heldScopeOf(ctx), record.id);
    }
    if (result.settled) {
      await holds.close(heldScopeOf(ctx), record.id);
    }
    return result;
  }

  private async execute(
    binding: CallBinding,
    call: AcpToolCall,
    callId: string,
    tool: Tool | undefined,
  ): ReturnType<typeof executeToolCall> {
    const args = this.unwrap(call);
    const presentation = presentToolCall(tool, args);
    // The tool as it names itself, not the name it goes by on the wire.
    const identity: ToolIdentity = tool
      ? identifyToolCall(tool, args)
      : {
          id: call.name,
        };
    if (!binding.provisional) {
      binding.events.bridgedCallStarted(callId, call.name, args, presentation, identity);
    }
    const record = this.records.recordFor({
      ctx: binding.ctx,
      stepId: binding.stepId,
      tool,
      wireName: call.name,
      args,
    });
    const replayed = record.take();
    if (replayed && mayWriteHolds(binding.ctx)) {
      // A host that died after recording this result, and before dropping the call's
      // intent or its answered hold, left them behind. The record says it is done.
      const holds = heldCallsOf(binding.ctx.harness);
      const executionId = heldScopeOf(binding.ctx);
      await holds.disarm(executionId, record.id);
      if (await holds.load(executionId, record.id)) {
        await holds.close(executionId, record.id);
      }
    }
    const result =
      replayed ??
      (await this.settle(binding, record, {
        signal: call.signal,
        params: {
          toolName: call.name,
          args,
          tools: this.source,
          context: binding.ctx,
          harness: binding.ctx.harness,
          layers: binding.layers,
          callId,
          recordId: record.id,
          // A provisional call's events wait for its owner: its progress is not shown.
          ...(binding.provisional
            ? {}
            : {
                onProgress: (progress: ToolProgressReport) =>
                  binding.events.toolEvent('tool_progress', {
                    name: call.name,
                    callId,
                    ...progress,
                  }),
              }),
          ...(binding.scope
            ? {
                scope: binding.scope,
              }
            : {}),
        },
      }));
    const callItem: FunctionCallItem = {
      id: callId,
      type: 'function_call',
      status: 'completed',
      callId,
      name: call.name,
      arguments: JSON.stringify(args ?? {}),
    };
    const outputItem = createToolResultItem({
      output: result.output,
      callId,
      roundItemSchemas: harnessItemSchemas(binding.ctx).extend(tool?.itemSchemas),
      tool,
      callItem,
      args,
      result: result.result,
      error: result.error,
    });
    const finished = {
      wireName: call.name,
      callItem,
      outputItem,
    };
    const content =
      result.error === true ? undefined : presentToolContent(tool, result.result, args);
    const completion = {
      name: call.name,
      error: result.error === true,
      output: result.output,
      ...(content
        ? {
            content,
          }
        : {}),
    };
    if (binding.provisional) {
      this.publish(binding, {
        ...finished,
        callId,
        deferred: {
          args,
          presentation,
          identity,
          completion,
        },
      });
      return result;
    }
    this.publish(binding, {
      ...finished,
      callId,
    });
    binding.events.bridgedCallCompleted(callId, completion);
    return result;
  }
}

/**
 * Put a finished call's result item on `bridge`: a provisional call's start
 * first and completion after, so its whole lifecycle lands on one stream.
 */
function emitResult(
  bridge: AcpEventBridge,
  call: Pick<SettledCall, 'callId' | 'wireName' | 'outputItem' | 'deferred'>,
): void {
  if (call.deferred) {
    bridge.bridgedCallStarted(
      call.callId,
      call.wireName,
      call.deferred.args,
      call.deferred.presentation,
      call.deferred.identity,
    );
  }
  bridge.itemAppended(call.outputItem);
  if (call.deferred) {
    bridge.bridgedCallCompleted(call.callId, call.deferred.completion);
  }
}

/**
 * The harness's own item schema registry, which the `callModel` tool loop
 * validates results against — not the context's, which layers extend.
 */
function harnessItemSchemas(ctx: Context<ContextData>): ItemSchemaRegistry {
  return (
    frameworkCast<{
      itemSchemas?: ItemSchemaRegistry;
    }>(ctx.harness).itemSchemas ?? defaultItemSchemaRegistry
  );
}

//#endregion

//#region Public API

/**
 * Resolve the step's tools into a runner, or `undefined` when it serves none.
 * The set is what a `callModel` step's model may call: `tools: []` is none;
 * `tools` given are those tools and the tools of the connections they list,
 * by their harness names, plus the context layers' tools when the run has no
 * unified tool set; no `tools` is every tool the run offers. A tool that runs
 * this very step is left out, the same tool listed twice counts once, and
 * server tools and colliding wire names are configuration errors.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when function-form `tools`
 * name a connection the turn never attached.
 */
export async function resolveAcpTools<TContext, I, O>(
  step: StepAcpAgent<TContext, I, O>,
  ctx: Context<TContext>,
  layers: ContextLayer[] | undefined,
): Promise<AcpToolRunner | undefined> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  const entries = await resolveLazy(step.tools, ctx);
  if (entries && entries.length === 0) {
    return undefined;
  }
  const listed = splitResolvedTools(step, entries, baseCtx);
  if (listed) {
    checkedAcpTools(step.id, [
      ...listed.tools,
      ...listed.serverTools,
    ]);
  }
  const tools = checkedAcpTools(
    step.id,
    offeredAcpTools(listed, layers, baseCtx).filter((tool) => acpDelegateStepOf(tool) !== step.id),
  );
  return tools.length > 0 ? new AcpToolRunner(tools) : undefined;
}

//#endregion

//#region Helpers

/**
 * What the step offers of the turn's tool set: its own tools as given, and
 * each listed connection's tools as the turn built them. With no `tools`, the
 * run's whole set but for connections only other steps list, or those past
 * its ceiling.
 */
function offeredAcpTools(
  listed: SplitStepTools | undefined,
  layers: ContextLayer[] | undefined,
  ctx: Context<ContextData>,
): Tool[] {
  const unified = ctx.unifiedTools;
  if (!unified || unified.length === 0) {
    return resolveToolsAndRestrictions(listed, layers, ctx).tools ?? [];
  }
  const turn = stepConnectionsOf(ctx);
  const picked =
    offeredTools(
      unified,
      {
        tools: [],
        serverTools: [],
        picks: listed?.picks ?? [],
      },
      turn,
    ) ?? [];
  // A ceiling narrows only connection tools, so the step keeps the rest whole.
  const own =
    listed && !listed.ceiling
      ? listed.tools
      : (offeredTools(unified, listed, turn) ?? [
          ...unified,
        ]);
  return deduplicateTools([
    ...own,
    ...picked,
  ]);
}

//#endregion
