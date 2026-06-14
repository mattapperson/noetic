/**
 * Default turn runner for the Claude Code sub-harness. Wraps Anthropic's
 * `@anthropic-ai/claude-agent-sdk` (an optional peer dependency) and maps its
 * message stream into normalized {@link SubHarnessStreamPart}s.
 *
 * The SDK is loaded by a runtime dynamic import so the package installs and
 * type-checks without it; a missing SDK surfaces as a {@link SubHarnessStartError}.
 * Tests (and callers who prefer the CLI) inject their own runner instead.
 */

import type {
  SubHarnessRunner,
  SubHarnessStreamPart,
  SubHarnessTurnInput,
} from '@noetic-tools/sub-harness';
import { SubHarnessStartError, withHistoryPrompt } from '@noetic-tools/sub-harness';
import { z } from 'zod';

//#region SDK boundary

const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

type QueryFn = (opts: unknown) => AsyncIterable<unknown>;

function readQueryFn(mod: unknown): QueryFn | null {
  if (typeof mod !== 'object' || mod === null) {
    return null;
  }
  const query = Reflect.get(mod, 'query');
  if (typeof query !== 'function') {
    return null;
  }
  return (opts) => query(opts);
}

async function loadQuery(): Promise<QueryFn> {
  let mod: unknown;
  try {
    mod = await import(SDK_MODULE);
  } catch (cause) {
    throw new SubHarnessStartError({
      harnessId: 'claude-code',
      message: `Could not load '${SDK_MODULE}'. Install it to use the Claude Code sub-harness, or pass a custom runner.`,
      cause,
    });
  }
  const query = readQueryFn(mod);
  if (!query) {
    throw new SubHarnessStartError({
      harnessId: 'claude-code',
      message: `'${SDK_MODULE}' did not export a 'query' function.`,
    });
  }
  return query;
}

//#endregion

//#region Message mapping

const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});
const AssistantMessageSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.unknown()),
  }),
});
const ResultMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

/** Map one Claude Code SDK message into zero or more stream parts. */
export function mapClaudeMessage(message: unknown): SubHarnessStreamPart[] {
  const assistant = AssistantMessageSchema.safeParse(message);
  if (assistant.success) {
    return assistant.data.message.content.flatMap(mapContentBlock);
  }
  const result = ResultMessageSchema.safeParse(message);
  if (result.success) {
    const { subtype, usage, total_cost_usd } = result.data;
    return [
      {
        type: 'finish',
        finishReason: subtype === undefined || subtype === 'success' ? 'stop' : 'error',
        usage: usage
          ? {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
            }
          : undefined,
        cost: total_cost_usd,
      },
    ];
  }
  return [
    {
      type: 'raw',
      value: message,
    },
  ];
}

function mapContentBlock(block: unknown): SubHarnessStreamPart[] {
  const text = TextBlockSchema.safeParse(block);
  if (text.success) {
    return [
      {
        type: 'text-delta',
        delta: text.data.text,
      },
    ];
  }
  const toolUse = ToolUseBlockSchema.safeParse(block);
  if (toolUse.success) {
    return [
      {
        type: 'tool-call',
        toolCallId: toolUse.data.id,
        toolName: toolUse.data.name,
        input: toolUse.data.input,
        providerExecuted: true,
      },
    ];
  }
  const thinking = ThinkingBlockSchema.safeParse(block);
  if (thinking.success) {
    return [
      {
        type: 'reasoning-delta',
        delta: thinking.data.thinking,
      },
    ];
  }
  // Never drop output: surface any unrecognized block as a raw part.
  return [
    {
      type: 'raw',
      value: block,
    },
  ];
}

//#endregion

//#region Runner

function buildQueryOptions(input: SubHarnessTurnInput): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cwd: input.ctx.cwd,
  };
  if (input.settings.model) {
    options.model = input.settings.model;
  }
  if (input.settings.permissionMode) {
    options.permissionMode = input.settings.permissionMode;
  }
  if (input.settings.maxTurns !== undefined) {
    options.maxTurns = input.settings.maxTurns;
  }
  if (input.settings.allowedTools) {
    options.allowedTools = [
      ...input.settings.allowedTools,
    ];
  }
  if (input.instructions) {
    options.customSystemPrompt = input.instructions;
  }
  if (input.signal) {
    options.abortController = toAbortController(input.signal);
  }
  return options;
}

function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
  }
  return controller;
}

/** @public The default Claude Code runner, backed by `@anthropic-ai/claude-agent-sdk`. */
export const defaultClaudeCodeRunner: SubHarnessRunner = async function* (input) {
  const query = await loadQuery();
  const stream = query({
    prompt: withHistoryPrompt(input),
    options: buildQueryOptions(input),
  });
  for await (const message of stream) {
    yield* mapClaudeMessage(message);
  }
};

//#endregion
