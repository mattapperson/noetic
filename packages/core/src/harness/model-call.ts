import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  FunctionCallItem,
  Item,
  ItemSchemaRegistry,
  LLMResponse,
  RoundUsage,
  Span,
  StandardSchemaV1,
  Tool,
  ToolChoice,
  TraceExporter,
} from '@noetic-tools/types';
import {
  frameworkCast,
  NoeticConfigError,
  SpendKind,
  SteerPoint,
  ToolChoiceMode,
} from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import type { OpenRouter } from '@openrouter/agent';
import { serverTool } from '@openrouter/agent';
import {
  convertTools,
  executeToolCall,
  extractOutputItems,
  extractSystemInstruction,
  extractUsage,
  itemsToInput,
  resolveWireJsonSchema,
  sanitizeToolNameForWire,
  toolsOnWire,
} from '../adapters/openrouter';
import { isFunctionCall } from '../interpreter/typeguards';
import { GenAI, NoeticAttr, ToolAttr } from '../observability/genai-attributes';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import { drainsOf } from '../runtime/drain';
import type { EventBroadcaster } from '../runtime/event-broadcaster';
import type { ApprovalOutcome } from '../runtime/tool-approval';
import { markSpent } from '../util/spent';
import { isErrorStatus } from '../util/status-code';
import type { Bill } from './call-spend';
import { CallSpend, noBill } from './call-spend';
import { exportSpans } from './deps/context';
import type { RoundRecord } from './model-rounds';
import { RoundLedger } from './model-rounds';
import { buildItemSchemaRegistry, createToolResultItem } from './model-schema.js';
import type { Dispatch, Spend } from './spend';
import type { SteerInbox } from './steer-inbox';
import { openSteerInbox } from './steer-inbox';

const MAX_TOOL_ROUNDS = 32;
const MAX_RECOVERY_CONTINUATIONS = 3;
const EPHEMERAL_CONTINUE_INPUT = 'continue';
const SKIPPED_FOR_STEER_OUTPUT = 'Skipped: a new message arrived before this tool call ran.';

function buildTextFormat(
  schema: StandardSchemaV1,
  explicitJsonSchema?: Record<string, unknown>,
): {
  format: {
    type: 'json_schema';
    name: string;
    schema: Record<string, unknown>;
  };
} {
  const jsonSchema = resolveWireJsonSchema({
    schema,
    explicitJsonSchema,
    what: 'structured output schema',
  });
  return {
    format: {
      type: 'json_schema',
      name: 'output',
      schema: jsonSchema,
    },
  };
}

function isStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ProviderTerminalError {
  status: string;
  message: string;
}

function providerTerminalError(response: unknown): ProviderTerminalError | null {
  if (!isStreamRecord(response) || response.status === undefined) {
    return null;
  }
  const status = String(response.status);
  if (status === 'completed') {
    return null;
  }
  if (status === 'incomplete') {
    const details = response.incompleteDetails;
    const reason =
      isStreamRecord(details) && typeof details.reason === 'string' ? `: ${details.reason}` : '';
    return {
      status,
      message: `LLM response incomplete${reason}`,
    };
  }
  if (status === 'failed') {
    const error = response.error;
    const message =
      isStreamRecord(error) && typeof error.message === 'string' ? `: ${error.message}` : '';
    return {
      status,
      message: `LLM response failed${message}`,
    };
  }
  return {
    status,
    message: `LLM response ended with status '${status}'`,
  };
}

/**
 * Tool rounds replay only their function calls. A round a steer follows must
 * also replay what the model said, or the next round starts without it.
 * Function calls are left to the tool round, which adds each with its output.
 */
function replayOutput(
  input: ReturnType<typeof itemsToInput>,
  roundItems: ReadonlyArray<Item>,
): void {
  input.push(...itemsToInput(roundItems.filter((item) => !isFunctionCall(item))));
}

/**
 * Save the generation id a stream's `response.created` event carries, for a response
 * whose headers did not. OpenRouter's ids start `gen-`; other ids price nothing.
 */
function noteStreamGeneration(dispatch: Dispatch | undefined, event: unknown): void {
  if (!dispatch || !isStreamRecord(event) || event.type !== 'response.created') {
    return;
  }
  const response = event.response;
  if (!isStreamRecord(response) || typeof response.id !== 'string') {
    return;
  }
  if (response.id.startsWith('gen-')) {
    void dispatch.noteGeneration(response.id);
  }
}

/** The provider refused the call before generating anything, so nothing was billed. */
function wasRefused(err: unknown, dispatch: Dispatch): boolean {
  return isErrorStatus(err) && dispatch.record.generationId === undefined;
}

function itemIds(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    'id' in item && typeof item.id === 'string'
      ? [
          item.id,
        ]
      : [],
  );
}

function hasItem(items: ReadonlyArray<Item>, id: string): boolean {
  return items.some((item) => 'id' in item && item.id === id);
}

function hasUsableResponseOutput(response: unknown, items: ReadonlyArray<Item>): boolean {
  if (items.length > 0) {
    return true;
  }
  return (
    isStreamRecord(response) &&
    typeof response.outputText === 'string' &&
    response.outputText.length > 0
  );
}

function withEphemeralContinueInput(
  input: ReturnType<typeof itemsToInput>,
): OpenRouterAgent.Item[] {
  return [
    ...frameworkCast<OpenRouterAgent.Item[]>(input),
    frameworkCast<OpenRouterAgent.Item>({
      type: 'message',
      role: 'user',
      content: EPHEMERAL_CONTINUE_INPUT,
    }),
  ];
}

/** Race a promise against an AbortSignal so callers (e.g. `SessionRunner.abort`)
 *  can break out of a long `await` without waiting for the underlying call to
 *  settle. When the signal fires, the returned promise rejects with
 *  `signal.reason` (an `Error`) or a generic `Error('aborted')` fallback. */
function awaitWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return p;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface PipeStreamOpts {
  stream: AsyncIterable<unknown>;
  /** Optional: when provided, each SDK event is emitted into it. Absent in
   *  headless/test harness runs that still need the idle watchdog to reset. */
  broadcaster?: EventBroadcaster;
  agentName: string;
  signal?: AbortSignal;
  /** Invoked once per SDK event received — used by the idle watchdog to bump
   *  its deadline so a still-streaming response isn't aborted. */
  onEvent?: (event: unknown) => void;
  /** Awaited with each finished output item before the next event is read. */
  onItemDone?: (item: unknown) => Promise<void>;
}

async function pipeStreamEventsToBroadcaster(opts: PipeStreamOpts): Promise<void> {
  const { stream, broadcaster, agentName, signal, onEvent, onItemDone } = opts;
  try {
    for await (const event of stream) {
      if (signal?.aborted) {
        return;
      }
      onEvent?.(event);
      if (!isStreamRecord(event)) {
        continue;
      }
      broadcaster?.emit({
        source: 'sdk',
        type: typeof event.type === 'string' ? event.type : 'unknown',
        data: event,
        outputIndex: typeof event.outputIndex === 'number' ? event.outputIndex : undefined,
        contentIndex: typeof event.contentIndex === 'number' ? event.contentIndex : undefined,
      });
      if (event.type === 'response.output_item.done' && onItemDone) {
        await onItemDone(event.item);
      }
    }
  } catch (err: unknown) {
    // The stream ends badly when the round is aborted; that is not a pipe fault.
    if (signal?.aborted) {
      return;
    }
    if (broadcaster) {
      emitFrameworkEvent({
        broadcaster,
        agentName,
        eventType: 'stream_pipe_error',
        data: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    throw err;
  }
}

interface StreamIdleWatchdog {
  /** Bump the deadline because a stream event just arrived. */
  reset: () => void;
  /** Clear the pending timer. Safe to call multiple times. */
  stop: () => void;
}

/** @internal The error for a model call on a harness with no LLM credentials. */
export function noLlmProviderError(): NoeticConfigError {
  return new NoeticConfigError({
    code: 'NO_LLM_PROVIDER',
    message: 'No LLM provider configured on this harness.',
    hint: 'Pass `callModelDefaults: { apiKey: "..." }` (defaults to the Noetic platform) or set NOETIC_API_KEY. For direct OpenRouter, use `callModelDefaults: { provider: "openrouter", apiKey: "..." }` or set OPENROUTER_API_KEY.',
  });
}

/** @internal Create a watchdog that aborts `controller` when no
 *  {@link StreamIdleWatchdog.reset reset} is called within `timeoutMs`. When
 *  `timeoutMs <= 0`, returns an inert no-op so callers can always call `.reset()`
 *  / `.stop()` without branching. Starts armed: the caller is responsible for
 *  `.stop()` in a `finally`. `onTimeout` runs before the abort so observers can
 *  emit a framework event with the original cause. Exported only for unit tests. */
export function createStreamIdleWatchdog(
  timeoutMs: number,
  controller: AbortController,
  onTimeout?: () => void,
): StreamIdleWatchdog {
  if (timeoutMs <= 0) {
    return {
      reset: () => {},
      stop: () => {},
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      const reason = new Error(`model stream idle timeout after ${timeoutMs}ms`);
      onTimeout?.();
      controller.abort(reason);
    }, timeoutMs);
  };
  arm();
  return {
    reset: () => {
      if (stopped || !timer) {
        return;
      }
      clearTimeout(timer);
      arm();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

//#endregion

interface PreparedModelRequest {
  instructions?: string;
  remaining: ReadonlyArray<Item>;
  broadcaster?: EventBroadcaster;
  sdkTools?: ReturnType<typeof convertTools>;
  /**
   * The wire tool choice, by round. A forcing choice (`required`, `{ tool }`)
   * holds only until the model has called a tool; later rounds fall back to
   * `auto`, or every round would force another call until the round limit.
   */
  toolChoice: {
    first: WireToolChoice;
    rest: WireToolChoice;
  };
  /**
   * The tools this call may run: the request's tools narrowed to
   * `allowedToolNames`. A call to any other tool is answered as unknown, so a
   * model that names a tool it was never offered cannot run it.
   */
  allowedTools: Tool[];
  emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
}

function prepareModelRequest(request: CallModelRequest, agentName: string): PreparedModelRequest {
  const { instructions: extractedInstructions, remaining } = extractSystemInstruction(
    request.items,
  );
  const instructions =
    [
      request.instructions,
      extractedInstructions,
    ]
      .filter(Boolean)
      .join('\n\n') || undefined;
  const broadcaster = getBroadcaster(request.ctx);
  const allowedTools = filterAllowedTools(request) ?? [];
  // Every request carries the full tool list, so the prompt-cache prefix is the
  // same for every step in the tree; `toolChoice` does the narrowing. A call
  // that may use no client tool sends none.
  // Client (function) tools convert to SDK tool definitions; OpenRouter server
  // tools (web_search/web_fetch) are wrapped via the SDK's `serverTool()` so
  // its convertToolsToAPIFormat accepts them — a raw `{type}` entry crashes it.
  // `parameters` keys stay camelCase: the SDK's outbound zod schema strips
  // unknown keys, so snake_case would be silently dropped.
  const clientSdkTools =
    request.tools && allowedTools.length > 0
      ? convertTools({
          tools: request.tools,
        })
      : [];
  const serverSdkTools = (request._serverTools ?? []).map((s) =>
    serverTool(
      frameworkCast<Parameters<typeof serverTool>[0]>({
        type: s.type,
        parameters: s.parameters,
      }),
    ),
  );
  const sdkTools = [
    ...clientSdkTools,
    ...frameworkCast<typeof clientSdkTools>(serverSdkTools),
  ];
  return {
    instructions,
    remaining,
    broadcaster,
    sdkTools: sdkTools.length > 0 ? sdkTools : undefined,
    toolChoice: roundToolChoices({
      request,
      allowedTools,
      sendsClientTools: clientSdkTools.length > 0,
      sendsTools: sdkTools.length > 0,
    }),
    allowedTools,
    emitIfAllowed(eventType, data) {
      if (!shouldEmit(request.emit, eventType, data)) {
        return;
      }
      emitFrameworkEvent({
        broadcaster,
        agentName,
        eventType,
        data,
      });
    },
  };
}

type WireToolChoice = OpenRouterAgent.CallModelInput['toolChoice'];

interface ToolChoiceScope {
  request: CallModelRequest;
  allowedTools: ReadonlyArray<Tool>;
  sendsClientTools: boolean;
  sendsTools: boolean;
}

function roundToolChoices(scope: ToolChoiceScope): PreparedModelRequest['toolChoice'] {
  const choice = scope.request.toolChoice ?? ToolChoiceMode.Auto;
  return {
    first: wireToolChoice(scope, choice),
    rest: wireToolChoice(scope, choice === ToolChoiceMode.None ? choice : ToolChoiceMode.Auto),
  };
}

/**
 * Map a `toolChoice` onto the wire, inside the step's restriction.
 * A restricted call narrows with an `allowed_tools` choice (plus the step's
 * server tools) rather than by trimming `tools`, so the request keeps the
 * shared cache prefix. `none` keeps the tools too, for the same reason. A call
 * that sends no tools sends no choice.
 *
 * @throws NoeticConfigError `UNKNOWN_TOOL_CHOICE` when `{ tool }` names a tool
 *   this call cannot run.
 */
function wireToolChoice(scope: ToolChoiceScope, choice: ToolChoice): WireToolChoice {
  const { request, allowedTools } = scope;
  if (typeof choice === 'object') {
    return forcedToolChoice(choice.tool, allowedTools);
  }
  if (!scope.sendsTools) {
    return undefined;
  }
  if (choice === ToolChoiceMode.None) {
    return 'none';
  }
  if (request.allowedToolNames && scope.sendsClientTools) {
    return allowedToolsChoice(request, allowedTools, choice);
  }
  return choice === ToolChoiceMode.Required ? 'required' : undefined;
}

/** Force one function tool. It must be one the call may run. */
function forcedToolChoice(name: string, allowedTools: ReadonlyArray<Tool>): WireToolChoice {
  const tool = allowedTools.find((candidate) => candidate.name === name);
  if (!tool) {
    const offered = allowedTools.map((t) => t.name).join(', ') || 'none';
    throw new NoeticConfigError({
      code: 'UNKNOWN_TOOL_CHOICE',
      message: `toolChoice forces tool ${JSON.stringify(name)}, which this model call cannot run.`,
      hint: `Force a tool the call offers (offered: ${offered}), or give '${name}' to the step or a context layer.`,
    });
  }
  return {
    type: 'function',
    name: sanitizeToolNameForWire(tool.name),
  };
}

/** Restrict the model to `allowedTools` (plus the step's server tools). */
function allowedToolsChoice(
  request: CallModelRequest,
  allowedTools: ReadonlyArray<Tool>,
  mode: typeof ToolChoiceMode.Auto | typeof ToolChoiceMode.Required,
): WireToolChoice {
  return {
    type: 'allowed_tools',
    mode,
    tools: [
      ...allowedTools.map((tool) => ({
        type: 'function',
        name: sanitizeToolNameForWire(tool.name),
      })),
      ...(request._serverTools ?? []).map((spec) => ({
        type: spec.type,
      })),
    ],
  };
}

/** Match a wire tool name against both the original and the sanitised name. */
function findTool(tools: ReadonlyArray<Tool>, wireName: string): Tool | undefined {
  return tools.find(
    (tool) => tool.name === wireName || sanitizeToolNameForWire(tool.name) === wireName,
  );
}

function filterAllowedTools(request: CallModelRequest): Tool[] | undefined {
  if (!request.tools) {
    return undefined;
  }
  if (!('allowedToolNames' in request) || !request.allowedToolNames) {
    return request.tools;
  }
  const allowedNames = new Set(request.allowedToolNames);
  return request.tools.filter((tool) => allowedNames.has(tool.name));
}

interface AgentHarnessModelCallerOpts {
  agentName: string;
  itemSchemas: ItemSchemaRegistry;
  client?: OpenRouter;
  callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  streamIdleTimeoutMs: number;
  harness: AgentHarnessContract;
  traceExporter: TraceExporter;
  /** Records each paid round before it is sent. Absent without durable storage. */
  spend?: Spend;
}

/**
 * Per-`callModel` span accumulator. Spans are created lazily from the calling
 * context's span (so the trace tree mirrors the execution tree) and flushed to
 * the harness `traceExporter` once the call settles — see issue #50, where the
 * exporter was stored but never invoked.
 */
class CallSpanCollector {
  private readonly spans: Span[] = [];

  constructor(
    private readonly harness: AgentHarnessContract,
    private readonly exporter: TraceExporter,
    private readonly parent: Span | null,
    private readonly nodeId: string | undefined,
    /** Stamped on the first model span only, then dropped. */
    private firstSpanAttributes: Record<string, string | number | boolean> | undefined,
  ) {}

  /** Link a span back to its declared workflow node, when the call carries one. */
  private stampNode(span: Span): void {
    if (this.nodeId !== undefined) {
      span.setAttribute(NoeticAttr.NODE_ID, this.nodeId);
    }
  }

  /** Open a model-call span stamped with GenAI semantic-convention attributes. */
  startModelSpan(model: string): Span {
    const span = this.harness.createSpan('llm.call', this.parent);
    span.setAttribute(GenAI.SYSTEM, 'openrouter');
    span.setAttribute(GenAI.REQUEST_MODEL, model);
    this.stampNode(span);
    for (const [key, value] of Object.entries(this.firstSpanAttributes ?? {})) {
      span.setAttribute(key, value);
    }
    this.firstSpanAttributes = undefined;
    this.spans.push(span);
    return span;
  }

  /** Record usage + cost on a model-call span. */
  finishModelSpan(span: Span, usage: RoundUsage, cost: number | undefined): void {
    span.setAttribute(GenAI.USAGE_INPUT_TOKENS, usage.inputTokens);
    span.setAttribute(GenAI.USAGE_OUTPUT_TOKENS, usage.outputTokens);
    if (usage.cachedTokens !== undefined) {
      span.setAttribute(GenAI.USAGE_CACHED_INPUT_TOKENS, usage.cachedTokens);
    }
    if (usage.cacheWriteTokens !== undefined) {
      span.setAttribute(GenAI.USAGE_CACHE_WRITE_TOKENS, usage.cacheWriteTokens);
    }
    if (cost !== undefined) {
      span.setAttribute(GenAI.COST, cost);
    }
    span.end();
  }

  /**
   * Open and immediately close a tool-call span under the given model span, or under
   * the call's parent when the round's model call ran in an earlier attempt.
   */
  recordToolSpan(
    parent: Span | null,
    toolName: string,
    needsApproval: boolean,
    approval: ApprovalOutcome | undefined,
  ): void {
    const span = this.harness.createSpan('tool.call', parent ?? this.parent);
    span.setAttribute(ToolAttr.NAME, toolName);
    span.setAttribute(ToolAttr.NEEDS_APPROVAL, needsApproval);
    if (approval !== undefined) {
      span.setAttribute(ToolAttr.APPROVAL, approval);
    }
    this.stampNode(span);
    span.end();
    this.spans.push(span);
  }

  /** Flush all accumulated spans to the exporter. */
  async flush(): Promise<void> {
    if (this.spans.length === 0) {
      return;
    }
    await exportSpans(this.exporter, this.spans);
  }
}

export class AgentHarnessModelCaller {
  constructor(private readonly opts: AgentHarnessModelCallerOpts) {}

  private newSpanCollector(request: CallModelRequest): CallSpanCollector {
    return new CallSpanCollector(
      this.opts.harness,
      this.opts.traceExporter,
      request.parentSpan ?? request.ctx?.span ?? null,
      request.nodeId,
      request.spanAttributes,
    );
  }

  /**
   * Broadcast a framework-authored item so `getItemStream` carries it — tool
   * results and injected messages never appear in the SDK stream. Emitted
   * unconditionally: item streaming, like the SDK item events, is not subject
   * to `step.emit` filtering.
   */
  private emitItemAppended(ctx: Context | undefined, item: Item): void {
    emitFrameworkEvent({
      broadcaster: getBroadcaster(ctx),
      agentName: this.opts.agentName,
      eventType: 'item_appended',
      data: {
        item,
      },
    });
  }

  private async callOverriddenModel(request: CallModelRequest): Promise<LLMResponse> {
    if (!this.opts.callModelOverride) {
      throw new Error('No callModel override configured.');
    }
    const spans = this.newSpanCollector(request);
    const modelSpan = spans.startModelSpan(request.model);
    const finished = drainsOf(request.ctx)?.track(request.ctx, {
      kind: 'model_round',
      model: request.model,
      round: 0,
    });
    let response: LLMResponse | undefined;
    try {
      response = await this.opts.callModelOverride(request);
      const itemSchemas = buildItemSchemaRegistry({
        base: this.opts.itemSchemas,
        layers: request.layers,
        tools: request.tools,
      });
      spans.finishModelSpan(modelSpan, response.usage, response.cost);
      return {
        ...response,
        items: itemSchemas.parseMany(response.items),
      };
    } finally {
      finished?.(
        response && {
          cost: response.cost ?? 0,
          usage: response.usage,
        },
      );
      await spans.flush();
    }
  }

  private requireModelClient(): OpenRouter {
    if (this.opts.client) {
      return this.opts.client;
    }
    throw noLlmProviderError();
  }

  async callModel(request: CallModelRequest): Promise<LLMResponse> {
    if (this.opts.callModelOverride) {
      return this.callOverriddenModel(request);
    }
    const client = this.requireModelClient();
    const spans = this.newSpanCollector(request);
    const spend = new CallSpend();
    const roundLedger = RoundLedger.open(request.ctx);
    try {
      return await this.runModelLoop({
        request,
        client,
        spans,
        spend,
        roundLedger,
      });
    } catch (error: unknown) {
      throw markSpent(error, spend.charge(), () => roundLedger?.charged());
    } finally {
      await spans.flush();
    }
  }

  private async runModelLoop({
    request,
    client,
    spans,
    spend,
    roundLedger,
  }: {
    request: CallModelRequest;
    client: OpenRouter;
    spans: CallSpanCollector;
    spend: CallSpend;
    roundLedger: RoundLedger | undefined;
  }): Promise<LLMResponse> {
    const prepared = prepareModelRequest(request, this.opts.agentName);
    const allItems: Item[] = [];
    let servedTier: string | undefined;
    const conversationInput = itemsToInput(prepared.remaining);
    const textFormat = request.outputSchema
      ? buildTextFormat(request.outputSchema, request.outputJsonSchema)
      : undefined;
    let round = 0;
    let invalidRecoveryContinuations = 0;
    let toolLimitRecoveryContinuations = 0;
    let useEphemeralContinue = false;
    const drains = drainsOf(request.ctx);
    const replaySchemas = buildItemSchemaRegistry({
      base: this.opts.itemSchemas,
      layers: request.layers,
      tools: request.tools,
    });
    // Where the loop's lists stood when the current round began, for its record.
    let marks = {
      round: -1,
      log: 0,
      input: 0,
      items: 0,
    };
    const markRound = (): void => {
      marks = {
        round,
        log: roundLedger?.mark() ?? 0,
        input: conversationInput.length,
        items: allItems.length,
      };
    };
    // The current round's checkpoint writes, in order. Its own record waits for
    // them, so a late checkpoint never replaces it.
    let checkpoints: Promise<void> = Promise.resolve();
    const writeRound = async (record: RoundRecord): Promise<void> => {
      if (!roundLedger || request.signal?.aborted) {
        return;
      }
      if (!(await roundLedger.record(round, marks.log, record))) {
        return;
      }
      prepared.emitIfAllowed('model_round_recorded', {
        round,
        itemIds: itemIds(record.items),
        done: !record.cut,
      });
    };
    // A rejected round is asked again on the conversation it was asked on, or fails
    // the call, so a resume must not go on from the items it streamed. The same goes
    // for the round that ends the loop.
    const dropCheckpoints = async (): Promise<void> => {
      await checkpoints;
      await roundLedger?.drop(round);
    };
    const rejectRound = async <
      T extends {
        kind: 'continue' | 'ok';
      },
    >(
      check: () => T,
    ): Promise<T> => {
      let result: T;
      try {
        result = check();
      } catch (error: unknown) {
        await dropCheckpoints();
        throw error;
      }
      if (result.kind === 'continue') {
        await dropCheckpoints();
      }
      return result;
    };
    // Record a round the loop goes on from, so a resumed loop can replay it.
    const recordRound = async (bill: Bill): Promise<void> => {
      await checkpoints;
      await writeRound({
        items: allItems.slice(marks.items),
        input: conversationInput.slice(marks.input),
        ...bill,
      });
    };
    // Record the output items a round has finished while it still streams, so a
    // resume goes on from them rather than making them again. The input holds only
    // what the round began with: the tool round adds each function call with its
    // output, as it does for a round that finishes.
    const checkpoint = (finished: Item[]): void => {
      if (!roundLedger) {
        return;
      }
      const record: RoundRecord = {
        items: [
          ...allItems.slice(marks.items),
          ...finished,
        ],
        input: conversationInput.slice(marks.input),
        ...noBill,
        cut: true,
      };
      checkpoints = checkpoints.then(() => writeRound(record));
    };
    let stoppedForRecall = false;
    const steers = openSteerInbox({
      ctx: request.ctx,
      layers: request.layers ?? [],
      harness: this.opts.harness,
      emit: prepared.emitIfAllowed,
      inConversation: (itemId) =>
        hasItem(allItems, itemId) || hasItem(request.ctx?.itemLog.items ?? [], itemId),
    });

    while (!request.signal?.aborted) {
      const replayed = roundLedger?.take(round, replaySchemas);
      if (replayed) {
        markRound();
        allItems.push(...replayed.items);
        conversationInput.push(...frameworkCast<typeof conversationInput>(replayed.input));
        for (const item of replayed.appended) {
          request.ctx?.itemLog.append(item);
        }
        // A cut round never reported usage, so it has no bill to count.
        if (!replayed.charged && !replayed.cut) {
          spend.replay(replayed);
        }
        prepared.emitIfAllowed('model_round_replayed', {
          round,
        });
        if (replayed.cut && !replayed.items.some(isFunctionCall)) {
          // The stream was cut after the answer finished: it ends the loop.
          break;
        }
        if (replayed.cut) {
          // Go on from the function calls the stream finished: run them, then ask
          // the model again with their results in the conversation.
          await this.runToolRound({
            roundItems: replayed.items,
            request,
            prepared,
            allItems,
            conversationInput,
            round,
            spans,
            modelSpan: null,
            steers,
          });
          await recordRound(spend.keep());
        }
        round += 1;
        const replayLimit = this.handleToolRoundLimit({
          round,
          toolLimitRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        });
        if (replayLimit.kind === 'continue') {
          toolLimitRecoveryContinuations = replayLimit.toolLimitRecoveryContinuations;
          useEphemeralContinue = true;
        }
        continue;
      }
      if (marks.round !== round) {
        markRound();
      }
      // A graceful stop starts no new round: wait here until it cancels the call.
      await drains?.hold(request.ctx);
      if (request.signal?.aborted) {
        break;
      }
      const recoveryContinuation = useEphemeralContinue;
      useEphemeralContinue = false;
      if (steers) {
        const recall = await this.applySteers({
          steers,
          ctx: request.ctx,
          conversationInput,
          allItems,
          round,
          emitIfAllowed: prepared.emitIfAllowed,
        });
        if (recall) {
          stoppedForRecall = true;
          break;
        }
      }

      const roundController = new AbortController();
      const roundSignal = request.signal
        ? AbortSignal.any([
            request.signal,
            roundController.signal,
          ])
        : roundController.signal;
      let firstEventSeen = false;
      let idleStalled = false;
      const watchdog = createStreamIdleWatchdog(
        this.opts.streamIdleTimeoutMs,
        roundController,
        () => {
          idleStalled = true;
          prepared.emitIfAllowed('model_call_stalled', {
            round,
            idleTimeoutMs: this.opts.streamIdleTimeoutMs,
          });
        },
      );
      const modelInput: OpenRouterAgent.Item[] = recoveryContinuation
        ? withEphemeralContinueInput(conversationInput)
        : frameworkCast<OpenRouterAgent.Item[]>(conversationInput);

      prepared.emitIfAllowed('model_call_started', {
        round,
        messageCount: modelInput.length,
        toolCount: prepared.sdkTools?.length ?? 0,
        recoveryContinuation,
      });

      const modelSpan = spans.startModelSpan(request.model);
      const dispatch = await this.opts.spend?.open({
        ctx: request.ctx ?? request._billTo,
        kind: SpendKind.Model,
        model: request.model,
        body: {
          model: request.model,
          instructions: prepared.instructions,
          input: modelInput,
          tools: prepared.sdkTools && toolsOnWire(prepared.sdkTools),
          text: textFormat,
        },
        maxOutputTokens: request.params?.maxTokens,
        round,
      });
      if (request.signal?.aborted) {
        // Aborted while the record was written: the call was never sent.
        await dispatch?.settle();
        modelSpan.end();
        break;
      }

      const roundFinished = drains?.track(
        request.ctx,
        {
          kind: 'model_round',
          model: request.model,
          round,
        },
        dispatch?.record,
      );
      const callResult = client.callModel(
        {
          model: request.model,
          input: modelInput,
          instructions: prepared.instructions,
          tools: prepared.sdkTools,
          toolChoice: round === 0 ? prepared.toolChoice.first : prepared.toolChoice.rest,
          temperature: request.params?.temperature,
          maxOutputTokens: request.params?.maxTokens,
          topP: request.params?.topP,
          // The agent's bundled SDK types an older tier list (no `fast` or
          // `ultrafast`); the field is an open enum, so newer tiers pass through.
          serviceTier: frameworkCast<OpenRouterAgent.CallModelInput['serviceTier']>(
            request.params?.serviceTier,
          ),
          ...(textFormat
            ? {
                text: textFormat,
              }
            : {}),
        },
        {
          signal: roundSignal,
          ...(dispatch
            ? {
                headers: dispatch.headers,
              }
            : {}),
        },
      );

      // Output items the stream has finished, kept so a steer can stop the
      // round early without losing them.
      const finishedItems: unknown[] = [];
      // Parsed for the round ledger; none once the stream has failed, since a call
      // that has thrown must write nothing more.
      const parsedItems: Item[] = [];
      let streaming = true;
      let steered = false;
      const pipePromise = pipeStreamEventsToBroadcaster({
        stream: callResult.getFullResponsesStream(),
        broadcaster: prepared.broadcaster,
        agentName: this.opts.agentName,
        signal: roundSignal,
        onEvent: (event) => {
          watchdog.reset();
          noteStreamGeneration(dispatch, event);
          if (!firstEventSeen) {
            firstEventSeen = true;
            prepared.emitIfAllowed('model_call_first_event', {
              round,
            });
          }
        },
        onItemDone: async (item) => {
          finishedItems.push(item);
          if (streaming && roundLedger) {
            try {
              parsedItems.push(
                ...replaySchemas.parseMany(
                  frameworkCast<Item[]>([
                    item,
                  ]),
                ),
              );
              checkpoint(parsedItems);
            } catch {
              // The round fails on this item when it ends; nothing after it can be
              // gone on from.
              streaming = false;
            }
          }
          if (!steers?.hasQueued() || !(await steers.offer(SteerPoint.ItemDone))) {
            return;
          }
          steered = true;
          roundController.abort(new Error('steered'));
        },
      });

      // A dropped connection rejects the response and the event pipe together; the
      // response's rejection is the one that propagates. Unobserved, the pipe's would
      // surface as an unhandled rejection and take the host process down with it.
      pipePromise.catch(() => {});
      let sdkResponse: Awaited<ReturnType<typeof callResult.getResponse>> | undefined;
      try {
        sdkResponse = await awaitWithAbort(callResult.getResponse(), roundSignal);
        watchdog.stop();
        // Counted before its record goes and before the recovery checks: a round
        // rejected below and asked again was billed all the same. Once counted, the
        // call charges its context with this bill however it ends, so a drain that
        // reports from here on lists the round finished with it.
        const roundUsage = extractUsage(sdkResponse.usage);
        const roundCost = sdkResponse.usage?.cost ?? 0;
        spend.count(roundUsage, roundCost);
        roundFinished?.({
          cost: roundCost,
          usage: roundUsage,
        });
        spans.finishModelSpan(modelSpan, roundUsage, roundCost > 0 ? roundCost : undefined);
        await dispatch?.settle();
        await awaitWithAbort(pipePromise, roundSignal);
      } catch (err: unknown) {
        streaming = false;
        await checkpoints;
        if (dispatch && wasRefused(err, dispatch)) {
          await dispatch.settle();
        }
        if (idleStalled) {
          throw roundSignal.reason instanceof Error
            ? roundSignal.reason
            : new Error(`model stream idle timeout after ${this.opts.streamIdleTimeoutMs}ms`);
        }
        if (!steered && !request.signal?.aborted) {
          throw err;
        }
      } finally {
        watchdog.stop();
        dispatch?.end();
        if (!sdkResponse) {
          roundFinished?.();
        }
      }
      if (request.signal?.aborted) {
        break;
      }
      if (!sdkResponse) {
        // A steer stopped the stream before the response finished. The provider
        // never reports usage for a cut response, so this round adds none.
        modelSpan.end();
        const bill = spend.keep();
        const roundItems = this.parseRoundItems(request, frameworkCast<Item[]>(finishedItems));
        prepared.emitIfAllowed('model_call_steered', {
          round,
          itemCount: roundItems.length,
        });
        allItems.push(...roundItems);
        replayOutput(conversationInput, roundItems);
        await this.runToolRound({
          roundItems,
          request,
          prepared,
          allItems,
          conversationInput,
          round,
          spans,
          modelSpan,
          steers,
        });
        await recordRound(bill);
        round += 1;
        const cutLimitRecovery = this.handleToolRoundLimit({
          round,
          toolLimitRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        });
        if (cutLimitRecovery.kind === 'continue') {
          toolLimitRecoveryContinuations = cutLimitRecovery.toolLimitRecoveryContinuations;
          useEphemeralContinue = true;
        }
        continue;
      }
      const recovery = await rejectRound(() =>
        this.handleModelRecovery({
          sdkResponse,
          round,
          invalidRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        }),
      );
      if (recovery.kind === 'continue') {
        invalidRecoveryContinuations = recovery.invalidRecoveryContinuations;
        useEphemeralContinue = true;
        continue;
      }

      const roundItems = this.parseRoundItems(request, extractOutputItems(sdkResponse));
      const outputRecovery = await rejectRound(() =>
        this.handleEmptyOutputRecovery({
          sdkResponse,
          roundItems,
          round,
          invalidRecoveryContinuations,
          emitIfAllowed: prepared.emitIfAllowed,
        }),
      );
      if (outputRecovery.kind === 'continue') {
        invalidRecoveryContinuations = outputRecovery.invalidRecoveryContinuations;
        useEphemeralContinue = true;
        continue;
      }
      invalidRecoveryContinuations = 0;
      const bill = spend.keep();
      prepared.emitIfAllowed('model_call_completed', {
        round,
        itemCount: sdkResponse.output?.length ?? 0,
      });
      servedTier = sdkResponse.serviceTier ?? undefined;
      allItems.push(...roundItems);

      const ranTools = await this.runToolRound({
        roundItems,
        request,
        prepared,
        allItems,
        conversationInput,
        round,
        spans,
        modelSpan,
        steers,
      });
      // A steer staged while the final answer streamed gets its own round, so
      // the model answers it inside this call rather than in the next turn.
      if (!ranTools && !steers?.hasStaged()) {
        // The step's own record covers the round that ends the loop. A cut record
        // left behind would hand a retry this answer after the step rejected it.
        await dropCheckpoints();
        break;
      }
      if (!ranTools) {
        replayOutput(conversationInput, roundItems);
      }
      await recordRound(bill);

      round += 1;
      const limitRecovery = this.handleToolRoundLimit({
        round,
        toolLimitRecoveryContinuations,
        emitIfAllowed: prepared.emitIfAllowed,
      });
      if (limitRecovery.kind === 'continue') {
        toolLimitRecoveryContinuations = limitRecovery.toolLimitRecoveryContinuations;
        useEphemeralContinue = true;
      }
    }

    return {
      items: allItems,
      ...spend.totals(),
      ...(stoppedForRecall
        ? {
            recall: true,
          }
        : {}),
      ...(servedTier
        ? {
            serviceTier: servedTier,
          }
        : {}),
    };
  }

  /**
   * Offer queued steers before a model call and add the applied ones to the
   * conversation. They join `allItems` rather than the log so the log keeps
   * them in the order the model saw them. Returns whether a layer asked for
   * recall to run again before the call goes on.
   */
  private async applySteers(params: {
    steers: SteerInbox;
    ctx: Context | undefined;
    conversationInput: ReturnType<typeof itemsToInput>;
    allItems: Item[];
    round: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): Promise<boolean> {
    const { steers, ctx, conversationInput, allItems } = params;
    await steers.offer(SteerPoint.BeforeRound);
    const { messageIds, items, recall } = steers.takeStaged();
    if (messageIds.length === 0) {
      return false;
    }
    conversationInput.push(...itemsToInput(items));
    for (const item of items) {
      allItems.push(item);
      this.emitItemAppended(ctx, item);
    }
    params.emitIfAllowed('inbox_injected', {
      round: params.round,
      count: messageIds.length,
      messageIds,
    });
    return recall;
  }

  private parseRoundItems(request: CallModelRequest, items: Item[]): Item[] {
    const roundItemSchemas = buildItemSchemaRegistry({
      base: this.opts.itemSchemas,
      layers: request.layers,
      tools: request.tools,
    });
    return roundItemSchemas.parseMany(items);
  }

  /** Run the round's function calls. Returns `false` when there were none to run. */
  private async runToolRound(params: {
    roundItems: Item[];
    request: CallModelRequest;
    prepared: PreparedModelRequest;
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    round: number;
    spans: CallSpanCollector;
    modelSpan: Span | null;
    steers: SteerInbox | undefined;
  }): Promise<boolean> {
    const functionCalls = params.roundItems.filter(isFunctionCall);
    if (functionCalls.length === 0 || !params.request.tools) {
      return false;
    }
    await this.executeToolRound({
      functionCalls,
      request: params.request,
      allowedTools: params.prepared.allowedTools,
      allItems: params.allItems,
      conversationInput: params.conversationInput,
      round: params.round,
      emitIfAllowed: params.prepared.emitIfAllowed,
      spans: params.spans,
      modelSpan: params.modelSpan,
      steers: params.steers,
    });
    return true;
  }

  private handleModelRecovery(params: {
    sdkResponse: unknown;
    round: number;
    invalidRecoveryContinuations: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }):
    | {
        kind: 'continue';
        invalidRecoveryContinuations: number;
      }
    | {
        kind: 'ok';
      } {
    const terminalError = providerTerminalError(params.sdkResponse);
    if (!terminalError) {
      return {
        kind: 'ok',
      };
    }
    params.emitIfAllowed('model_call_failed', {
      round: params.round,
      status: terminalError.status,
      error: terminalError.message,
      recoverable: params.invalidRecoveryContinuations < MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.invalidRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(terminalError.message);
    }
    const next = params.invalidRecoveryContinuations + 1;
    params.emitIfAllowed('model_call_recovery_continue', {
      round: params.round,
      status: terminalError.status,
      attempt: next,
      maxAttempts: MAX_RECOVERY_CONTINUATIONS,
    });
    return {
      kind: 'continue',
      invalidRecoveryContinuations: next,
    };
  }

  private handleEmptyOutputRecovery(params: {
    sdkResponse: unknown;
    roundItems: ReadonlyArray<Item>;
    round: number;
    invalidRecoveryContinuations: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }):
    | {
        kind: 'continue';
        invalidRecoveryContinuations: number;
      }
    | {
        kind: 'ok';
      } {
    if (hasUsableResponseOutput(params.sdkResponse, params.roundItems)) {
      return {
        kind: 'ok',
      };
    }
    const message = 'LLM response completed with no output items';
    params.emitIfAllowed('model_call_failed', {
      round: params.round,
      status: 'completed',
      error: message,
      recoverable: params.invalidRecoveryContinuations < MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.invalidRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(message);
    }
    const next = params.invalidRecoveryContinuations + 1;
    params.emitIfAllowed('model_call_recovery_continue', {
      round: params.round,
      status: 'completed',
      attempt: next,
      maxAttempts: MAX_RECOVERY_CONTINUATIONS,
    });
    return {
      kind: 'continue',
      invalidRecoveryContinuations: next,
    };
  }

  private async executeToolRound(params: {
    functionCalls: Extract<
      Item,
      {
        type: 'function_call';
      }
    >[];
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    round: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
    spans: CallSpanCollector;
    modelSpan: Span | null;
    steers: SteerInbox | undefined;
  }): Promise<void> {
    const {
      functionCalls,
      request,
      allowedTools,
      allItems,
      conversationInput,
      spans,
      modelSpan,
      steers,
    } = params;
    params.emitIfAllowed('tool_round_started', {
      round: params.round,
      toolCount: functionCalls.length,
    });
    for (const fc of functionCalls) {
      conversationInput.push({
        type: 'function_call',
        callId: fc.callId,
        id: fc.id ?? crypto.randomUUID(),
        name: fc.name,
        arguments: fc.arguments,
      });
    }
    for (const [index, fc] of functionCalls.entries()) {
      await drainsOf(request.ctx)?.hold(request.ctx);
      if (request.signal?.aborted) {
        break;
      }
      const remaining = functionCalls.slice(index);
      if (steers?.hasQueued() && (await steers.offer(SteerPoint.BeforeToolCall, remaining))) {
        for (const skipped of remaining) {
          this.recordSkippedToolCall({
            fc: skipped,
            request,
            allowedTools,
            allItems,
            conversationInput,
            emitIfAllowed: params.emitIfAllowed,
          });
        }
        break;
      }
      const toolForCall = findTool(allowedTools, fc.name);
      const approval = await this.executeFunctionCall({
        fc,
        request,
        allowedTools,
        allItems,
        conversationInput,
        emitIfAllowed: params.emitIfAllowed,
      });
      spans.recordToolSpan(modelSpan, fc.name, toolForCall?.needsApproval ?? false, approval);
    }
    params.emitIfAllowed('tool_round_completed', {
      round: params.round,
      toolCount: functionCalls.length,
    });
  }

  private async executeFunctionCall(params: {
    fc: Extract<
      Item,
      {
        type: 'function_call';
      }
    >;
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): Promise<ApprovalOutcome | undefined> {
    const { fc, request, allowedTools, allItems, conversationInput } = params;
    params.emitIfAllowed('tool_call_started', {
      name: fc.name,
      callId: fc.callId,
    });
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(fc.arguments);
    } catch {
      this.recordUnrunToolCall({
        fc,
        output: `Error: malformed JSON in tool arguments: ${fc.arguments}`,
        request,
        allowedTools,
        allItems,
        conversationInput,
        emitIfAllowed: params.emitIfAllowed,
      });
      return undefined;
    }
    if (!request.tools) {
      throw new Error(
        `executeFunctionCall invoked without tools on CallModelRequest (tool name: ${fc.name}).`,
      );
    }
    const toolForCall = findTool(allowedTools, fc.name);
    const toolResult = await executeToolCall({
      toolName: fc.name,
      args: parsedArgs,
      tools: allowedTools,
      context: request.ctx,
      harness: this.opts.harness,
      layers: request.layers,
      callId: fc.callId,
    });
    // Owner-scoped result validation: a tool's `toolResults` schemas apply
    // only to that tool's own result items. Harness-level `opts.itemSchemas`
    // stay global by design; sibling tools' schemas never reject this item.
    const outputItem = createToolResultItem({
      output: toolResult.output,
      callId: fc.callId,
      roundItemSchemas: this.opts.itemSchemas.extend(toolForCall?.itemSchemas),
      tool: toolForCall,
      callItem: fc,
      args: parsedArgs,
      result: toolResult.result,
      error: toolResult.error,
    });
    allItems.push(outputItem);
    conversationInput.push({
      type: 'function_call_output',
      callId: fc.callId,
      output: toolResult.output,
    });
    this.emitItemAppended(request.ctx, outputItem);
    params.emitIfAllowed('tool_call_completed', {
      name: fc.name,
      callId: fc.callId,
      error: toolResult.error === true,
      output: toolResult.output,
    });
    return toolResult.approval;
  }

  private recordSkippedToolCall(params: {
    fc: FunctionCallItem;
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): void {
    params.emitIfAllowed('tool_call_started', {
      name: params.fc.name,
      callId: params.fc.callId,
    });
    this.recordUnrunToolCall({
      ...params,
      output: SKIPPED_FOR_STEER_OUTPUT,
    });
  }

  /** Answer a call that never ran, so every call in the history has an output. */
  private recordUnrunToolCall(params: {
    fc: FunctionCallItem;
    output: string;
    request: CallModelRequest;
    allowedTools: Tool[];
    allItems: Item[];
    conversationInput: ReturnType<typeof itemsToInput>;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }): void {
    const { fc, request, allowedTools, allItems, conversationInput } = params;
    const toolForCall = findTool(allowedTools, fc.name);
    // Owner-scoped result validation (see executeFunctionCall).
    const outputItem = createToolResultItem({
      output: params.output,
      callId: fc.callId,
      roundItemSchemas: this.opts.itemSchemas.extend(toolForCall?.itemSchemas),
      tool: toolForCall,
      callItem: fc,
      error: true,
    });
    allItems.push(outputItem);
    conversationInput.push({
      type: 'function_call_output',
      callId: fc.callId,
      output: params.output,
    });
    this.emitItemAppended(request.ctx, outputItem);
    params.emitIfAllowed('tool_call_completed', {
      name: fc.name,
      callId: fc.callId,
      error: true,
      output: params.output,
    });
  }

  private handleToolRoundLimit(params: {
    round: number;
    toolLimitRecoveryContinuations: number;
    emitIfAllowed: (eventType: string, data: Record<string, unknown>) => void;
  }):
    | {
        kind: 'continue';
        toolLimitRecoveryContinuations: number;
      }
    | {
        kind: 'ok';
      } {
    if (params.round < MAX_TOOL_ROUNDS) {
      return {
        kind: 'ok',
      };
    }
    params.emitIfAllowed('tool_round_limit_exceeded', {
      maxToolRounds: MAX_TOOL_ROUNDS,
      attempt: params.toolLimitRecoveryContinuations + 1,
      maxAttempts: MAX_RECOVERY_CONTINUATIONS,
    });
    if (params.toolLimitRecoveryContinuations >= MAX_RECOVERY_CONTINUATIONS) {
      throw new Error(`LLM exceeded maximum tool rounds (${MAX_TOOL_ROUNDS})`);
    }
    return {
      kind: 'continue',
      toolLimitRecoveryContinuations: params.toolLimitRecoveryContinuations + 1,
    };
  }
}
