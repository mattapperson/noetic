/**
 * The `chat@1` profile (spec 36 § Catalog v1): messaging workspaces, for
 * agents that start conversations and wait on people. A bot that answers
 * every message belongs on `@noetic-tools/chat-sdk` (spec 29).
 *
 * Text is CommonMark. `chat.channel` and `chat.user` refs are public.
 */

import { defineProfile, receipt, ref, SenseDefaults } from '@noetic-tools/types';
import { z } from 'zod';

//#region Field schemas

/** @public The ref kind of a channel. Channel refs are public. */
export const CHAT_CHANNEL_KIND = 'chat.channel';

/** @public The ref kind of a thread. */
export const CHAT_THREAD_KIND = 'chat.thread';

/** @public The ref kind of a message. */
export const CHAT_MESSAGE_KIND = 'chat.message';

/** @public The ref kind of a user. User refs are public. */
export const CHAT_USER_KIND = 'chat.user';

/** @public The identity surface chat connections report. */
export const CHAT_SURFACE = 'x-chat';

function channelRef(): ReturnType<typeof ref<'chat.channel'>> {
  return ref(CHAT_CHANNEL_KIND, {
    public: true,
  });
}

function threadRef(): ReturnType<typeof ref<'chat.thread'>> {
  return ref(CHAT_THREAD_KIND);
}

function messageRef(): ReturnType<typeof ref<'chat.message'>> {
  return ref(CHAT_MESSAGE_KIND);
}

function userRef(): ReturnType<typeof ref<'chat.user'>> {
  return ref(CHAT_USER_KIND, {
    public: true,
  });
}

/** CommonMark text. */
const text = z.string().min(1);

const cursorPage = {
  cursor: z.string().min(1).optional(),
};

function withReceipt<const S extends z.ZodRawShape>(
  shape: S,
): z.ZodObject<
  S & {
    receipt: ReturnType<typeof receipt>;
  }
> {
  return z.object({
    ...shape,
    receipt: receipt(),
  });
}

//#endregion

//#region Schemas

/** @public A message as history, reads and events carry it. */
export const ChatMessageSchema = z.object({
  message: messageRef(),
  thread: threadRef(),
  channel: channelRef(),
  author: z.object({
    user: userRef(),
    name: z.string().optional(),
  }),
  /** CommonMark. */
  text: z.string(),
  /** ISO 8601. */
  time: z.string().min(1),
  mentionsAgent: z.boolean().optional(),
});

/** @public What `chat.thread.recent` reads. */
export const ChatRecentSchema = z.object({
  thread: threadRef().nullable(),
  messages: z.array(ChatMessageSchema),
});

/** @public A reaction as `chat.reaction.added` carries it. */
export const ChatReactionSchema = z.object({
  message: messageRef(),
  thread: threadRef(),
  channel: channelRef(),
  user: userRef(),
  emoji: z.string().min(1),
});

const historyInput = z
  .object({
    channel: channelRef().optional(),
    thread: threadRef().optional(),
    ...cursorPage,
    limit: z.number().int().positive().optional(),
  })
  .refine((v) => v.channel === undefined || v.thread === undefined, {
    message: 'Give channel or thread, not both.',
  });

//#endregion

//#region Profile

/** @public The `chat@1` profile. */
export const chat = defineProfile({
  name: 'chat',
  version: '1.0.0',
  description: 'A messaging workspace: post, reply, read history, wait on people.',
  surface: CHAT_SURFACE,
  determinism: {
    reset: 'none',
    replayPrefix: 'unsafe',
    time: 'wall',
    observation: 'exact',
    actions: 'irreversible',
  },
  operations: {
    'chat.post': {
      description: 'Post a message in a channel, starting a thread.',
      input: z.object({
        channel: channelRef(),
        text,
      }),
      output: withReceipt({
        message: messageRef(),
        thread: threadRef(),
      }),
      effects: true,
      once: true,
      eager: true,
    },
    'chat.reply': {
      description: 'Reply in a thread.',
      input: z.object({
        thread: threadRef(),
        text,
      }),
      output: withReceipt({
        message: messageRef(),
      }),
      effects: true,
      once: true,
      eager: true,
    },
    'chat.history': {
      description: 'Messages of a channel or a thread, newest first, by page.',
      input: historyInput,
      output: z.object({
        messages: z.array(ChatMessageSchema),
        ...cursorPage,
      }),
      sense: 'state',
      eager: true,
    },
    'chat.channels': {
      description: 'Channels the connection can see, by page.',
      input: z.object(cursorPage),
      output: z.object({
        channels: z.array(
          z.object({
            channel: channelRef(),
            name: z.string(),
          }),
        ),
        ...cursorPage,
      }),
    },
    'chat.react': {
      description: 'Add a reaction to a message.',
      input: z.object({
        message: messageRef(),
        emoji: z.string().min(1),
      }),
      output: withReceipt({}),
      effects: true,
      required: false,
    },
    'chat.edit': {
      description: "Replace a message's text.",
      input: z.object({
        message: messageRef(),
        text,
      }),
      output: withReceipt({}),
      effects: true,
      required: false,
    },
    'chat.delete': {
      description: 'Delete a message.',
      input: z.object({
        message: messageRef(),
      }),
      output: withReceipt({}),
      effects: true,
      guarded: true,
      required: false,
    },
    'chat.users': {
      description: 'Users of the workspace, by page.',
      input: z.object(cursorPage),
      output: z.object({
        users: z.array(
          z.object({
            user: userRef(),
            name: z.string(),
          }),
        ),
        ...cursorPage,
      }),
      required: false,
    },
  },
  reads: {
    'chat.thread.recent': {
      description: 'The recent messages of the current thread.',
      schema: ChatRecentSchema,
      sense: 'state',
      look: 'effect',
    },
  },
  events: {
    'chat.message.created': {
      description: 'A message was posted.',
      payload: ChatMessageSchema,
      arguments: z.object({
        channel: channelRef().optional(),
        thread: threadRef().optional(),
        mentionsAgent: z.boolean().optional(),
      }),
      sense: 'state',
      replay: 'durable',
      thread: 'thread',
    },
    'chat.message.updated': {
      description: 'A message was edited.',
      payload: ChatMessageSchema,
      sense: 'state',
      replay: 'durable',
      thread: 'thread',
      required: false,
    },
    'chat.reaction.added': {
      description: 'A reaction was added to a message.',
      payload: ChatReactionSchema,
      sense: 'state',
      replay: 'durable',
      thread: 'thread',
      required: false,
    },
  },
  senses: {
    state: SenseDefaults.state,
  },
});

//#endregion
