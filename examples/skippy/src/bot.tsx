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

let initPromise: Promise<NoeticChat<SkippyAdapters>> | undefined;

function createBot(env: Env): NoeticChat<SkippyAdapters> {
  const harness = new AgentHarness({
    name: 'skippy',
    initialStep: step.llm({
      id: 'respond',
      model: 'anthropic/claude-sonnet-4-5',
      system: [
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
  if (!initPromise) {
    const instance = createBot(env);
    initPromise = instance.initialize().then(() => instance);
  }
  return initPromise;
}

//#endregion
