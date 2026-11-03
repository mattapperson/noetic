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
import { createToolResultItem, executeToolCall, resolveWireJsonSchema } from '../runtime/tool-call';
import { sanitizeToolNameForWire } from '../util/tool-name';
import type { AcpEventBridge } from './acp-events';
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
  const adopted: string[] = [];
  const merged = [
    ...items,
  ];
  const claimed = new Set<string>();
  const unclaimedCall = (match: (item: FunctionCallItem) => boolean): number =>
    merged.findIndex((item) => isFunctionCall(item) && !claimed.has(item.callId) && match(item));
  for (const call of calls) {
    const byId = unclaimedCall((item) => item.callId === call.callItem.callId);
    const index = byId >= 0 ? byId : unclaimedCall((item) => namesBridgedCall(item, call.wireName));
    const found = index >= 0 ? merged[index] : undefined;
    if (!found || !isFunctionCall(found)) {
      merged.push(call.callItem, call.outputItem);
      continue;
    }
    claimed.add(found.callId);
    if (found.callId !== call.callItem.callId) {
      adopted.push(call.callItem.callId);
    }
    const outputIndex = merged.findIndex((item) => isOutputFor(item, found.callId));
    merged[index] = call.callItem;
    if (outputIndex >= 0) {
      merged[outputIndex] = call.outputItem;
    } else {
      merged.splice(index + 1, 0, call.outputItem);
    }
  }
  return {
    items: merged,
    adopted,
  };
}

//#endregion

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
  private finished: BridgedCall[] = [];
  private round = 0;
  /** Set when a call's pipeline threw: the turn is failing, so no further call runs. */
  private failed = false;
  /** The agent's announced tool calls, by id, with their titles. */
  private readonly announced = new Map<string, string>();
  /** Ids already given to a call this session; an agent may not reuse one. */
  private readonly claimed = new Set<string>();

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
  }

  /** The calls finished since the last take, in the order they ran. */
  takeFinished(): BridgedCall[] {
    const finished = this.finished;
    this.finished = [];
    return finished;
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
    try {
      return await this.runInRound(binding, call, callId);
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
    binding: AcpToolBinding,
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

  private async execute(
    binding: AcpToolBinding,
    call: AcpToolCall,
    callId: string,
    tool: Tool | undefined,
  ): ReturnType<typeof executeToolCall> {
    const args = this.unwrap(call);
    binding.events.toolEvent('tool_call_started', {
      name: call.name,
      callId,
    });
    const result = await executeToolCall({
      toolName: call.name,
      args,
      tools: this.source,
      context: binding.ctx,
      harness: binding.ctx.harness,
      layers: binding.layers,
      callId,
    });
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
    this.finished.push({
      wireName: call.name,
      callItem,
      outputItem,
    });
    binding.events.itemAppended(outputItem);
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
 * run's whole set but for connections only other steps list.
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
  const own = listed
    ? listed.tools
    : (offeredTools(unified, undefined, turn) ?? [
        ...unified,
      ]);
  return deduplicateTools([
    ...own,
    ...picked,
  ]);
}

//#endregion
