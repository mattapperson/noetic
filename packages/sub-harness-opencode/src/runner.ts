/**
 * Default turn runner for the opencode sub-harness. Wraps sst's
 * `@opencode-ai/sdk` (an optional peer dependency) and maps its message stream
 * into normalized {@link SubHarnessStreamPart}s.
 *
 * The SDK is loaded by a runtime dynamic import so the package installs and
 * type-checks without it; a missing SDK surfaces as a {@link SubHarnessStartError}.
 * Tests (and callers who prefer the CLI) inject their own runner instead.
 *
 * The exact opencode event shapes are uncertain, so {@link mapOpencodeMessage}
 * maps defensively with Zod `safeParse` and falls back to a `raw` part for
 * anything it does not recognise.
 */

import type {
  SubHarnessRunner,
  SubHarnessStreamPart,
  SubHarnessTurnInput,
} from '@noetic-tools/sub-harness';
import { SubHarnessStartError, withHistoryPrompt } from '@noetic-tools/sub-harness';
import { z } from 'zod';

//#region SDK boundary

const SDK_MODULE = '@opencode-ai/sdk';

type RunFn = (opts: unknown) => AsyncIterable<unknown>;

function readRunFn(mod: unknown): RunFn | null {
  if (typeof mod !== 'object' || mod === null) {
    return null;
  }
  const run = Reflect.get(mod, 'run');
  if (typeof run !== 'function') {
    return null;
  }
  return (opts) => run(opts);
}

async function loadRun(): Promise<RunFn> {
  let mod: unknown;
  try {
    mod = await import(SDK_MODULE);
  } catch (cause) {
    throw new SubHarnessStartError({
      harnessId: 'opencode',
      message: `Could not load '${SDK_MODULE}'. Install it to use the opencode sub-harness, or pass a custom runner.`,
      cause,
    });
  }
  const run = readRunFn(mod);
  if (!run) {
    throw new SubHarnessStartError({
      harnessId: 'opencode',
      message: `'${SDK_MODULE}' did not export a 'run' function.`,
    });
  }
  return run;
}

//#endregion

//#region Message mapping

const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
const TextMessageSchema = z.object({
  type: z.enum([
    'message',
    'text',
    'assistant',
  ]),
  part: z.unknown().optional(),
  text: z.string().optional(),
});
const ToolMessageSchema = z.object({
  type: z.enum([
    'tool',
    'tool_use',
    'tool_call',
  ]),
  id: z.string().optional(),
  callID: z.string().optional(),
  tool: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  args: z.unknown().optional(),
});
const UsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});
const FinishMessageSchema = z.object({
  type: z.enum([
    'session.idle',
    'done',
    'finish',
    'result',
  ]),
  usage: UsageSchema.optional(),
  cost: z.number().optional(),
});

function rawPart(message: unknown): SubHarnessStreamPart[] {
  return [
    {
      type: 'raw',
      value: message,
    },
  ];
}

function extractText(data: z.infer<typeof TextMessageSchema>): string | null {
  if (typeof data.text === 'string') {
    return data.text;
  }
  const part = TextPartSchema.safeParse(data.part);
  if (part.success) {
    return part.data.text;
  }
  return null;
}

function mapTextMessage(message: unknown): SubHarnessStreamPart[] | null {
  const parsed = TextMessageSchema.safeParse(message);
  if (!parsed.success) {
    return null;
  }
  const text = extractText(parsed.data);
  if (text === null) {
    return null;
  }
  return [
    {
      type: 'text-delta',
      delta: text,
    },
  ];
}

function mapToolMessage(message: unknown): SubHarnessStreamPart[] | null {
  const parsed = ToolMessageSchema.safeParse(message);
  if (!parsed.success) {
    return null;
  }
  const { id, callID, tool, name, input, args } = parsed.data;
  return [
    {
      type: 'tool-call',
      toolCallId: id ?? callID ?? '',
      toolName: tool ?? name ?? '',
      input: input ?? args,
      providerExecuted: true,
    },
  ];
}

function mapUsage(usage: z.infer<typeof UsageSchema>): {
  input: number;
  output: number;
} {
  return {
    input: usage.input ?? usage.inputTokens ?? 0,
    output: usage.output ?? usage.outputTokens ?? 0,
  };
}

function mapFinishMessage(message: unknown): SubHarnessStreamPart[] | null {
  const parsed = FinishMessageSchema.safeParse(message);
  if (!parsed.success) {
    return null;
  }
  const { usage, cost } = parsed.data;
  return [
    {
      type: 'finish',
      finishReason: 'stop',
      usage: usage ? mapUsage(usage) : undefined,
      cost,
    },
  ];
}

/** Map one opencode SDK message into zero or more stream parts. */
export function mapOpencodeMessage(message: unknown): SubHarnessStreamPart[] {
  return (
    mapTextMessage(message) ??
    mapToolMessage(message) ??
    mapFinishMessage(message) ??
    rawPart(message)
  );
}

//#endregion

//#region Runner

function buildRunOptions(input: SubHarnessTurnInput): Record<string, unknown> {
  const options: Record<string, unknown> = {
    prompt: withHistoryPrompt(input),
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
    options.instructions = input.instructions;
  }
  if (input.signal) {
    options.signal = input.signal;
  }
  return options;
}

/** @public The default opencode runner, backed by `@opencode-ai/sdk`. */
export const defaultOpencodeRunner: SubHarnessRunner = async function* (input) {
  const run = await loadRun();
  const stream = run(buildRunOptions(input));
  for await (const message of stream) {
    yield* mapOpencodeMessage(message);
  }
};

//#endregion
