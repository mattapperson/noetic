import type { DiscordAdapter } from '@chat-adapter/discord';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createMemoryState } from '@chat-adapter/state-memory';
import { chatStream, NoeticChat } from '@noetic/chat-sdk';
import { AgentHarness, step } from '@noetic/core';
import { Card, CardText as Text } from 'chat';
import type { Env } from './env';

//#region Types

type SkippyAdapters = {
  discord: DiscordAdapter;
};

//#endregion

//#region Bot Factory

const botCache = new Map<string, Promise<NoeticChat<SkippyAdapters>>>();

function envCacheKey(env: Env): string {
  return [
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_PUBLIC_KEY,
    env.DISCORD_APPLICATION_ID,
    env.OPENROUTER_API_KEY,
    env.WORKER_URL,
  ].join(':');
}

function createBot(env: Env): NoeticChat<SkippyAdapters> {
  const harness = new AgentHarness({
    name: 'skippy',
    initialStep: step.llm({
      id: 'respond',
      model: 'anthropic/claude-sonnet-4-5',
      instructions: [
        'You are Skippy, a helpful and friendly Discord bot.',
        'Keep responses concise and conversational — this is chat, not an essay.',
        'Use markdown formatting when it helps readability.',
      ].join(' '),
    }),
    params: {},
    llm: {
      provider: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY,
    },
  });

  const bot = new NoeticChat({
    userName: 'skippy',
    adapters: {
      discord: createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        applicationId: env.DISCORD_APPLICATION_ID,
      }),
    },
    state: createMemoryState(),
    fallbackStreamingPlaceholderText: null,
    harness,
    autoSubscribe: true,
    maxHistoryMessages: 20,
  });

  bot.onNewMention(async (thread, message, execute): Promise<void> => {
    await thread.post(
      <Card title="Skippy">
        <Text>Hey! I'm listening. Let me think...</Text>
      </Card>,
    );

    const result = execute(message.text);
    await thread.post(chatStream(result));
  });

  return bot;
}

export function getInitializedBot(env: Env): Promise<NoeticChat<SkippyAdapters>> {
  const key = envCacheKey(env);
  const cached = botCache.get(key);
  if (cached) {
    return cached;
  }
  const instance = createBot(env);
  const promise = instance
    .initialize()
    .then(() => instance)
    .catch((err: unknown) => {
      botCache.delete(key);
      throw err;
    });
  botCache.set(key, promise);
  return promise;
}

//#endregion
