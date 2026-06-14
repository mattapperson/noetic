/**
 * Default turn runner for the Codex sub-harness. Wraps OpenAI's
 * `@openai/codex-sdk` (an optional peer dependency) and maps its event stream
 * into normalized {@link SubHarnessStreamPart}s.
 *
 * The SDK is loaded by a runtime dynamic import so the package installs and
 * type-checks without it; a missing SDK surfaces as a {@link SubHarnessStartError}.
 * Tests (and callers who prefer the CLI) inject their own runner instead.
 *
 * The exact Codex SDK event shapes are uncertain, so {@link mapCodexMessage}
 * maps defensively: several plausible event shapes are tried via Zod
 * `safeParse`, and anything unrecognized falls back to a `raw` part. The SDK
 * entry point (`new Codex().startThread()` then a streamed run) is likewise
 * read defensively via `Reflect.get`.
 */

import type {
  SubHarnessRunner,
  SubHarnessStreamPart,
  SubHarnessTurnInput,
} from '@noetic-tools/sub-harness';
import { SubHarnessStartError, withHistoryPrompt } from '@noetic-tools/sub-harness';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';

//#region SDK boundary

const SDK_MODULE = '@openai/codex-sdk';

/** A started Codex thread that runs a prompt and streams events. */
interface CodexThread {
  runStreamed: (prompt: string) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

/** The minimal Codex client surface this runner relies on. */
interface CodexClient {
  startThread: (options?: unknown) => CodexThread | Promise<CodexThread>;
}

type CodexCtor = new (options?: unknown) => CodexClient;

function readCodexCtor(mod: unknown): CodexCtor | null {
  if (typeof mod !== 'object' || mod === null) {
    return null;
  }
  const codex = Reflect.get(mod, 'Codex');
  if (typeof codex !== 'function') {
    return null;
  }
  return frameworkCast<CodexCtor>(codex);
}

async function loadCodexCtor(): Promise<CodexCtor> {
  let mod: unknown;
  try {
    mod = await import(SDK_MODULE);
  } catch (cause) {
    throw new SubHarnessStartError({
      harnessId: 'codex',
      message: `Could not load '${SDK_MODULE}'. Install @openai/codex-sdk to use the Codex sub-harness, or pass a custom runner.`,
      cause,
    });
  }
  const ctor = readCodexCtor(mod);
  if (!ctor) {
    throw new SubHarnessStartError({
      harnessId: 'codex',
      message: `'${SDK_MODULE}' did not export a 'Codex' class. Install @openai/codex-sdk, or pass a custom runner.`,
    });
  }
  return ctor;
}

//#endregion

//#region Message mapping

const TextMessageSchema = z.object({
  type: z.enum([
    'item.completed',
    'agent_message',
    'text',
    'assistant',
  ]),
  text: z.string(),
});

const ToolCallSchema = z.object({
  type: z.enum([
    'command',
    'tool_call',
    'function_call',
  ]),
  id: z.string().optional(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  command: z.string().optional(),
  input: z.unknown().optional(),
  arguments: z.unknown().optional(),
});

const FileChangeSchema = z.object({
  type: z.enum([
    'apply_patch',
    'file_change',
  ]),
  path: z.string().optional(),
});

const ResultSchema = z.object({
  type: z.enum([
    'turn.completed',
    'thread.completed',
    'result',
    'done',
  ]),
  status: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      cached_input_tokens: z.number().optional(),
    })
    .optional(),
  cost: z.number().optional(),
  total_cost_usd: z.number().optional(),
});

function mapText(text: string): SubHarnessStreamPart[] {
  return [
    {
      type: 'text-delta',
      delta: text,
    },
  ];
}

function mapToolCall(call: z.infer<typeof ToolCallSchema>): SubHarnessStreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: call.id ?? call.call_id ?? '',
      toolName: call.name ?? call.command ?? '',
      input: call.input ?? call.arguments,
      providerExecuted: true,
    },
  ];
}

function mapResult(result: z.infer<typeof ResultSchema>): SubHarnessStreamPart[] {
  const { status, usage, cost, total_cost_usd } = result;
  return [
    {
      type: 'finish',
      finishReason: status === 'failed' || status === 'error' ? 'error' : 'stop',
      usage: usage
        ? {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            total: usage.total_tokens,
            cached: usage.cached_input_tokens,
          }
        : undefined,
      cost: cost ?? total_cost_usd,
    },
  ];
}

/** Map one Codex SDK event into zero or more stream parts. */
export function mapCodexMessage(message: unknown): SubHarnessStreamPart[] {
  const text = TextMessageSchema.safeParse(message);
  if (text.success) {
    return mapText(text.data.text);
  }
  const toolCall = ToolCallSchema.safeParse(message);
  if (toolCall.success) {
    return mapToolCall(toolCall.data);
  }
  const fileChange = FileChangeSchema.safeParse(message);
  if (fileChange.success) {
    return [
      {
        type: 'file-change',
        path: fileChange.data.path,
      },
    ];
  }
  const result = ResultSchema.safeParse(message);
  if (result.success) {
    return mapResult(result.data);
  }
  return [
    {
      type: 'raw',
      value: message,
    },
  ];
}

//#endregion

//#region Runner

function buildThreadOptions(input: SubHarnessTurnInput): Record<string, unknown> {
  const options: Record<string, unknown> = {
    workingDirectory: input.ctx.cwd,
  };
  if (input.settings.model) {
    options.model = input.settings.model;
  }
  if (input.settings.allowedTools) {
    options.allowedTools = [
      ...input.settings.allowedTools,
    ];
  }
  if (input.instructions) {
    options.instructions = input.instructions;
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

/** @public The default Codex runner, backed by `@openai/codex-sdk`. */
export const defaultCodexRunner: SubHarnessRunner = async function* (input) {
  const Codex = await loadCodexCtor();
  const options = buildThreadOptions(input);
  const client = new Codex(options);
  const thread = await client.startThread(options);
  const stream = await thread.runStreamed(withHistoryPrompt(input));
  for await (const message of stream) {
    yield* mapCodexMessage(message);
  }
};

//#endregion
