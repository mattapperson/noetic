/**
 * Default turn runner for the Pi sub-harness. Wraps the Pi agent SDK
 * (`@pi-agent/sdk`, an optional peer dependency) and maps its in-process event
 * stream into normalized {@link SubHarnessStreamPart}s.
 *
 * Pi runs as an in-process Node library, so there is no separate CLI, port, or
 * startup timeout — but the same injectable-runner + lazy-import pattern as the
 * other sub-harnesses applies. The SDK is loaded by a runtime dynamic import so
 * the package installs and type-checks without it; a missing SDK (or one that
 * exports no recognizable entry) surfaces as a {@link SubHarnessStartError}.
 * Pi's event shape is not stable, so every event is mapped defensively with Zod
 * `safeParse` — unrecognized events fall back to a `raw` part. Tests inject
 * their own runner instead.
 */

import type {
  SubHarnessRunner,
  SubHarnessStreamPart,
  SubHarnessTurnInput,
} from '@noetic-tools/sub-harness';
import { SubHarnessStartError, withHistoryPrompt } from '@noetic-tools/sub-harness';
import { z } from 'zod';

//#region SDK boundary

const SDK_MODULE = '@pi-agent/sdk';

/** Pi is in-process; its entry is one of these callables, tried in order. */
const ENTRY_NAMES: ReadonlyArray<string> = [
  'query',
  'run',
  'createPiSession',
];

type PiEntryFn = (opts: unknown) => AsyncIterable<unknown>;

function readEntryFn(mod: unknown): PiEntryFn | null {
  if (typeof mod !== 'object' || mod === null) {
    return null;
  }
  for (const name of ENTRY_NAMES) {
    const candidate = Reflect.get(mod, name);
    if (typeof candidate === 'function') {
      return (opts) => candidate(opts);
    }
  }
  return null;
}

async function loadEntry(): Promise<PiEntryFn> {
  let mod: unknown;
  try {
    mod = await import(SDK_MODULE);
  } catch (cause) {
    throw new SubHarnessStartError({
      harnessId: 'pi',
      message: `Could not load '${SDK_MODULE}'. Install @pi-agent/sdk to use the Pi sub-harness, or pass a custom runner.`,
      cause,
    });
  }
  const entry = readEntryFn(mod);
  if (!entry) {
    throw new SubHarnessStartError({
      harnessId: 'pi',
      message: `'${SDK_MODULE}' did not export a 'query', 'run', or 'createPiSession' function.`,
    });
  }
  return entry;
}

//#endregion

//#region Message mapping

const TextEventSchema = z.object({
  type: z.enum([
    'text',
    'assistant',
    'message',
  ]),
  text: z.string().optional(),
  delta: z.string().optional(),
});
const ReasoningEventSchema = z.object({
  type: z.enum([
    'reasoning',
    'thinking',
  ]),
  text: z.string().optional(),
  delta: z.string().optional(),
});
const ToolEventSchema = z.object({
  type: z.enum([
    'tool',
    'tool_call',
  ]),
  id: z.string().optional(),
  callId: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  arguments: z.unknown().optional(),
});
const TerminalEventSchema = z.object({
  type: z.enum([
    'done',
    'finish',
    'result',
    'end',
  ]),
  usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
  cost: z.number().optional(),
  error: z.string().optional(),
});

function deltaPart(
  type: 'text-delta' | 'reasoning-delta',
  event: {
    text?: string;
    delta?: string;
  },
): SubHarnessStreamPart[] {
  const delta = event.text ?? event.delta;
  if (delta === undefined) {
    return [];
  }
  return [
    {
      type,
      delta,
    },
  ];
}

function mapToolEvent(event: z.infer<typeof ToolEventSchema>): SubHarnessStreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: event.id ?? event.callId ?? crypto.randomUUID(),
      toolName: event.name ?? '',
      input: event.input ?? event.arguments,
      providerExecuted: true,
    },
  ];
}

function readUsage(usage: z.infer<typeof TerminalEventSchema>['usage']):
  | {
      input: number;
      output: number;
    }
  | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    input: usage.input ?? usage.inputTokens ?? 0,
    output: usage.output ?? usage.outputTokens ?? 0,
  };
}

function mapTerminalEvent(event: z.infer<typeof TerminalEventSchema>): SubHarnessStreamPart[] {
  return [
    {
      type: 'finish',
      finishReason: event.error === undefined ? 'stop' : 'error',
      usage: readUsage(event.usage),
      cost: event.cost,
    },
  ];
}

/** @public Map one Pi SDK event into zero or more stream parts. */
export function mapPiMessage(message: unknown): SubHarnessStreamPart[] {
  const text = TextEventSchema.safeParse(message);
  if (text.success) {
    return deltaPart('text-delta', text.data);
  }
  const reasoning = ReasoningEventSchema.safeParse(message);
  if (reasoning.success) {
    return deltaPart('reasoning-delta', reasoning.data);
  }
  const tool = ToolEventSchema.safeParse(message);
  if (tool.success) {
    return mapToolEvent(tool.data);
  }
  const terminal = TerminalEventSchema.safeParse(message);
  if (terminal.success) {
    return mapTerminalEvent(terminal.data);
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

/** Thinking budget passed to the Pi SDK, mirrors {@link PiOptions.thinkingLevel}. */
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

function buildRunnerOptions(
  input: SubHarnessTurnInput,
  thinkingLevel?: ThinkingLevel,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cwd: input.ctx.cwd,
    prompt: withHistoryPrompt(input),
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
    options.systemPrompt = input.instructions;
  }
  if (thinkingLevel) {
    options.thinkingLevel = thinkingLevel;
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

/** @public Build a Pi runner backed by `@pi-agent/sdk` with an optional thinking level. */
export function createDefaultPiRunner(thinkingLevel?: ThinkingLevel): SubHarnessRunner {
  return async function* (input) {
    const entry = await loadEntry();
    const stream = entry(buildRunnerOptions(input, thinkingLevel));
    for await (const message of stream) {
      yield* mapPiMessage(message);
    }
  };
}

/** @public The default Pi runner, backed by `@pi-agent/sdk`. */
export const defaultPiRunner: SubHarnessRunner = createDefaultPiRunner();

//#endregion
