/**
 * `callModel` helper exposed to plugins via `PluginContext`.
 *
 * Uses OpenRouter's OpenAI-compatible chat completions endpoint directly so
 * the plugin API stays decoupled from the `@openrouter/agent` response-mode
 * SDK the harness uses. Plugins get a simple "send messages, get text back"
 * contract suitable for one-shot generation (deck options, interview
 * follow-ups, etc.).
 */

import { z } from 'zod';

//#region Types

export type CallModelRole = 'system' | 'user' | 'assistant';

export interface CallModelMessage {
  role: CallModelRole;
  content: string;
}

export interface CallModelInput {
  messages: ReadonlyArray<CallModelMessage>;
  /** Override the agent's default model for this call. */
  model?: string;
  /** Sampling temperature. Defaults to 0.7. */
  temperature?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface CallModelResponse {
  text: string;
  modelId: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type CallModel = (input: CallModelInput) => Promise<CallModelResponse>;

//#endregion

//#region Wire schema

const CompletionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});

//#endregion

//#region Factory

/**
 * Minimal fetch-like shape accepted by `createCallModel` — intentionally
 * narrower than the full `typeof fetch` so tests can pass simple async stubs
 * without implementing `preconnect`, etc.
 */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface CreateCallModelArgs {
  apiKey: string;
  defaultModel: string;
  /** Override the OpenRouter endpoint, mostly for tests. */
  endpoint?: string;
  /** Override `fetch` for tests. */
  fetchFn?: FetchLike;
}

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export function createCallModel(args: CreateCallModelArgs): CallModel {
  const endpoint = args.endpoint ?? DEFAULT_ENDPOINT;
  const fetchFn = args.fetchFn ?? fetch;
  return async function callModel(input) {
    const body = {
      model: input.model ?? args.defaultModel,
      messages: input.messages,
      temperature: input.temperature ?? 0.7,
    };
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`callModel failed: ${response.status} ${response.statusText} ${text}`);
    }
    const parsed = CompletionSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`callModel: malformed response: ${parsed.error.message}`);
    }
    const choice = parsed.data.choices[0];
    if (!choice) {
      throw new Error('callModel: empty choices array');
    }
    const text = choice.message.content ?? '';
    return {
      text,
      modelId: parsed.data.model ?? body.model,
      usage: parsed.data.usage
        ? {
            promptTokens: parsed.data.usage.prompt_tokens,
            completionTokens: parsed.data.usage.completion_tokens,
            totalTokens: parsed.data.usage.total_tokens,
          }
        : undefined,
    };
  };
}

//#endregion
