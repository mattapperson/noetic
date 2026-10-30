import type {
  CallModelRequest,
  Item,
  StandardSchemaV1,
  Tool,
  ToolChoice,
} from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError, ToolChoiceMode } from '@noetic-tools/types';
import type * as OpenRouterAgent from '@openrouter/agent';
import { serverTool } from '@openrouter/agent';
import {
  convertTools,
  extractSystemInstruction,
  resolveWireJsonSchema,
  sanitizeToolNameForWire,
} from '../adapters/openrouter';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from '../runtime/broadcaster-utils';
import type { EventBroadcaster } from '../runtime/event-broadcaster';

/**
 * Shapes a `callModel` request for the wire: system instructions, the SDK tool
 * list, the per-round tool choice, and the structured-output text format.
 */

//#region Model request preparation

export function buildTextFormat(
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

export interface PreparedModelRequest {
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

export function prepareModelRequest(
  request: CallModelRequest,
  agentName: string,
): PreparedModelRequest {
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
export function findTool(tools: ReadonlyArray<Tool>, wireName: string): Tool | undefined {
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

//#endregion
