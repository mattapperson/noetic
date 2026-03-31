import { createDiscordAdapter } from '@chat-adapter/discord';
import { createMemoryState } from '@chat-adapter/state-memory';
import { chatStream, NoeticChat } from '@noetic/chat-sdk';
import { AgentHarness, step } from '@noetic/core';
import { Card, CardText as Text } from 'chat';

//#region Agent Setup

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
  },
});

//#endregion

//#region Bot Setup

export const bot = new NoeticChat({
  userName: 'skippy',
  adapters: {
    discord: createDiscordAdapter(),
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

//#endregion
