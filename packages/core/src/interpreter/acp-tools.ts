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
} from '@noetic-tools/types';
import {
  bridgedToolTitles,
  defaultItemSchemaRegistry,
  frameworkCast,
  namesBridgedToolCall,
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
import { createToolResultItem, executeToolCall, resolveWireJsonSchema } from '../runtime/tool-call';
import { sanitizeToolNameForWire } from '../util/tool-name';
import type { AcpEventBridge } from './acp-events';
import type { BridgedCallRecord } from './acp-resume';
import { BridgedCallRecords } from './acp-resume';
import { openChildSpan, traceChild } from './child-span';
import { deduplicateTools } from './collect-tools';
import { resolveLazy, resolveToolsAndRestrictions, splitResolvedTools } from './execute-action';
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

/** One call's binding: where it reports, and whose it is. */
interface CallBinding extends AcpToolBinding {
  /** Who made the call, settled once before it runs. */
  owner: CallOwner;
  /** The nested agent making it, when a subagent's. */
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
  const title = tool.acp?.title;
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
  /** Bridge `callId`s now standing where an agent record with another id was. */
  adopted: string[];
} {
  // Only the agent's own records are matched — never a pair this merge added —
  // exact ids before titles, each record claimed once.
  const slotOf = matchBridgedCalls(items, calls);
  const adopted: string[] = [];
  const byRecord = new Map<string, BridgedCall>();
  for (const [call, index] of slotOf) {
    const record = items[index];
    if (!record || !isFunctionCall(record)) {
      continue;
    }
    byRecord.set(record.callId, call);
    if (record.callId !== call.callItem.callId) {
      adopted.push(call.callItem.callId);
    }
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
    adopted,
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

/**
 * Who made a bridged call: the step's own agent, a subagent, or — for a call
 * nobody announced in a turn with subagents — the step's until the turn ends,
 * when a late announcement can still claim it for a subagent.
 */
type CallOwner =
  | {
      kind: 'step';
    }
  | {
      kind: 'subagent';
      sessionId: string;
    }
  | {
      kind: 'provisional';
    };

/** A finished call, in the order calls finished. */
interface SettledCall extends BridgedCall {
  readonly callId: string;
  /**
   * Set while the call's result item is not yet on the stream: published on
   * these step events, in queue order, when the turn's calls are taken.
   */
  readonly pending?: AcpEventBridge;
  /** Its owner is not settled yet: a subagent announcing it by then takes it. */
  readonly provisional?: boolean;
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
  /** The agent's announced tool calls, by id, with their titles. */
  private readonly announced = new Map<string, string>();
  /** Who announced each call: the step's own session, or a subagent's. */
  private readonly owners = new Map<string, CallOwner>();
  /** Calls waiting to be placed, woken by their announcement. */
  private readonly waiting = new Map<string, () => void>();
  /** Set once a subagent is heard from this turn: calls may then be theirs. */
  private subagentsThisTurn = false;
  /** Calls held for a person right now, by the agent's call id, with their record id. */
  private readonly holding = new Map<string, string>();
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
  }

  /** Stop running calls: the turn they belonged to has ended. */
  unbind(): void {
    this.binding = undefined;
    this.announced.clear();
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

  /** The tool's wire name when `title` is how an agent titles a call to it. */
  wireNameOf(title: string): string | undefined {
    return this.tools.find((tool) => bridgedToolTitles(this.serverName, tool.name).includes(title))
      ?.name;
  }

  /** Note an agent `tool_call`, so a call without an id in `_meta` can take its id. */
  observe(update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call') {
      return;
    }
    this.announced.set(update.toolCallId, update.title);
    // The step's own announcement places a call; no subagent's can take it after.
    this.owners.set(update.toolCallId, {
      kind: 'step',
    });
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
    this.announced.set(update.toolCallId, update.title);
    if (this.owners.get(update.toolCallId)?.kind !== 'step') {
      this.owners.set(update.toolCallId, {
        kind: 'subagent',
        sessionId,
      });
      this.renameAsker(update.toolCallId, sessionId);
    }
    this.wake(update.toolCallId);
  }

  /** A call already held for a person turns out to be a subagent's: the hold names it. */
  private renameAsker(callId: string, sessionId: string): void {
    const recordId = this.holding.get(callId);
    const binding = this.binding;
    if (recordId === undefined || !binding || !mayWriteHolds(binding.ctx)) {
      return;
    }
    const scope = binding.events.scopeFor(sessionId);
    void heldCallsOf(binding.ctx.harness)
      .rescope(heldScopeOf(binding.ctx), recordId, scope)
      .catch(() => undefined);
  }

  private wake(callId: string): void {
    const waiter = this.waiting.get(callId);
    if (waiter) {
      this.waiting.delete(callId);
      waiter();
    }
  }

  /**
   * Who made a call, settled before it runs. The MCP request names no session,
   * so a call is placed by the `tool_call` that announced it. A turn with no
   * subagents places every call with the step, at once. Once a subagent has
   * spoken this turn, a call nobody has announced yet waits for its
   * announcement — at most a moment — and one still unannounced runs as the
   * step's provisionally: it is never dropped, and only at the turn's end,
   * with every announcement in, is it given to a subagent that claimed it.
   */
  private async ownerOf(callId: string): Promise<CallOwner> {
    const known = this.owners.get(callId);
    if (known) {
      return known;
    }
    // A subagent's announcement may still come, even before its first update
    // reaches us: the call is the step's only provisionally. With no subagent
    // heard from yet there is nothing to wait for.
    if (!this.subagentsThisTurn) {
      return {
        kind: 'provisional',
      };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(callId);
        resolve();
      }, ANNOUNCEMENT_GRACE_MS);
      this.waiting.set(callId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return (
      this.owners.get(callId) ?? {
        kind: 'provisional',
      }
    );
  }

  /** The binding a call reports through: its subagent's nested agent, or the step's. */
  private bindingFor(binding: AcpToolBinding, owner: CallOwner): CallBinding {
    const child =
      owner.kind === 'subagent' ? binding.events.childBridge(owner.sessionId) : undefined;
    const scope = owner.kind === 'subagent' ? binding.events.scopeFor(owner.sessionId) : undefined;
    return {
      ...binding,
      ...(child
        ? {
            events: child,
          }
        : {}),
      owner,
      ...(scope
        ? {
            scope,
          }
        : {}),
      stepEvents: binding.events,
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
      const owner = call.provisional ? this.owners.get(call.callId) : undefined;
      if (owner?.kind === 'subagent') {
        call.pending?.childBridge(owner.sessionId)?.itemAppended(call.outputItem);
        continue;
      }
      call.pending?.itemAppended(call.outputItem);
      taken.push(call);
    }
    this.finished = [];
    // The turn's calls are settled: their owners are no longer needed.
    this.owners.clear();
    return taken;
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
    for (const [id, title] of this.announced) {
      if (
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
      if (callId !== undefined) {
        this.holding.delete(callId);
      }
    }
  }

  /**
   * The nested agent a call is now known to be from — read when each hold opens,
   * since an announcement can land while the call is running.
   */
  private latestScope(binding: CallBinding, callId: string | undefined): AgentScope | undefined {
    const owner = callId === undefined ? undefined : this.owners.get(callId);
    return owner?.kind === 'subagent'
      ? binding.stepEvents.scopeFor(owner.sessionId)
      : binding.scope;
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
      this.holding.set(params.callId ?? held.callId, held.callId);
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
        this.holding.delete(params.callId ?? held.callId);
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
    binding.events.toolEvent('tool_call_started', {
      name: call.name,
      callId,
    });
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
    // One queue, in the order calls finished. A subagent's call is never the
    // step's. A provisional call stays open only while a subagent has spoken
    // this turn — then its item waits for the turn's end, and any step result
    // after it waits behind it, so the stream keeps the order calls finished.
    // The owner as it stands now: a subagent may have announced the call while
    // it ran.
    const owner: CallOwner =
      binding.owner.kind === 'provisional'
        ? (this.owners.get(callId) ?? binding.owner)
        : binding.owner;
    if (owner.kind === 'subagent') {
      (binding.stepEvents.childBridge(owner.sessionId) ?? binding.events).itemAppended(outputItem);
    } else {
      const open = owner.kind === 'provisional' && this.subagentsThisTurn;
      if (owner.kind === 'provisional' && !open) {
        this.owners.set(callId, {
          kind: 'step',
        });
      }
      const behind = open || this.finished.some((settled) => settled.pending !== undefined);
      this.finished.push({
        ...finished,
        callId,
        ...(open
          ? {
              provisional: true,
            }
          : {}),
        ...(behind
          ? {
              pending: binding.stepEvents,
            }
          : {}),
      });
      if (!behind) {
        binding.stepEvents.itemAppended(outputItem);
      }
    }
    binding.events.toolEvent('tool_call_completed', {
      name: call.name,
      callId,
      error: result.error === true,
      output: result.output,
    });
    return result;
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
