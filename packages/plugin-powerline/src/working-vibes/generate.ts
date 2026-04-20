/**
 * AI-generated loading messages. Calls OpenRouter's chat completion endpoint
 * directly (OpenAI-compatible) to avoid a hard SDK coupling — the plugin only
 * ever generates on startup and caches the result.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

interface GenerateArgs {
  apiKey: string;
  theme: string;
  poolSize: number;
  model?: string;
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
const DEFAULT_GEN_MODEL = 'openai/gpt-4o-mini';

const ChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
});

const CacheFileSchema = z.object({
  at: z.number(),
  theme: z.string(),
  messages: z.array(z.string()),
});

export function cachePath(theme: string): string {
  return join(homedir(), '.cache', 'noetic', 'vibes', `${theme}.json`);
}

export function readCache(theme: string, now: number): string[] | null {
  try {
    const raw = readFileSync(cachePath(theme), 'utf8');
    const parsed = CacheFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    if (parsed.data.theme !== theme) {
      return null;
    }
    if (now - parsed.data.at > CACHE_TTL_MS) {
      return null;
    }
    return parsed.data.messages;
  } catch {
    return null;
  }
}

export function writeCache(theme: string, messages: string[], now: number): void {
  const path = cachePath(theme);
  try {
    mkdirSync(dirname(path), {
      recursive: true,
    });
    writeFileSync(
      path,
      JSON.stringify({
        at: now,
        theme,
        messages,
      } satisfies z.infer<typeof CacheFileSchema>),
    );
  } catch {
    // Cache is best-effort.
  }
}

export async function generateVibes(args: GenerateArgs): Promise<string[]> {
  const cached = readCache(args.theme, Date.now());
  if (cached !== null && cached.length >= args.poolSize) {
    return cached;
  }
  const messages = await callOpenRouter(args);
  if (messages.length > 0) {
    writeCache(args.theme, messages, Date.now());
  }
  return messages;
}

async function callOpenRouter(args: GenerateArgs): Promise<string[]> {
  const prompt = buildPrompt(args.theme, args.poolSize);
  const body = {
    model: args.model ?? DEFAULT_GEN_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a playful assistant.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 1,
  };
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return [];
  }
  const parsed = ChatCompletionSchema.safeParse(await response.json());
  if (!parsed.success) {
    return [];
  }
  const firstChoice = parsed.data.choices[0];
  if (!firstChoice) {
    return [];
  }
  return parseMessagesFromContent(firstChoice.message.content);
}

export function parseMessagesFromContent(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/^\s*[-*\d.]+\s*/, '').trim())
    .filter((line) => line.length > 0 && line.length <= 40 && !line.startsWith('#'));
}

function buildPrompt(theme: string, poolSize: number): string {
  return (
    `Generate exactly ${poolSize} short loading-spinner verbs in the style of "${theme}".\n` +
    `Each line is 1-3 words, present continuous ("Engaging", "Warping", "Shanghai-ing").\n` +
    'No numbering, no trailing punctuation, no quotes. One per line.'
  );
}
