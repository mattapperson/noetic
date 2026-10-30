import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { profileFieldOf } from '@noetic-tools/types';
import { z } from 'zod';
import {
  CHAT_SURFACE,
  ChatMessageSchema,
  ChatRecentSchema,
  chat,
  PROFILE_NAME,
} from '../src/index';
import { checkOperation, flagsOf, receiptOf, refOf } from './_helpers';

const channel = refOf('chat.channel');
const thread = refOf('chat.thread');
const messageRef = refOf('chat.message');
const user = refOf('chat.user');
const message = {
  message: messageRef,
  thread,
  channel,
  author: {
    user,
    name: 'Ada',
  },
  text: 'Ship it?',
  time: '2026-10-29T12:00:00Z',
  mentionsAgent: true,
};
const done = {
  receipt: receiptOf(),
};

describe('chat@1 profile', () => {
  it('has its identity', () => {
    expect(PROFILE_NAME).toBe('chat');
    expect(chat.id).toBe('chat@1');
    expect(chat.parents).toEqual({});
    expect(chat.definition.surface).toBe(CHAT_SURFACE);
    expect(CHAT_SURFACE).toBe('x-chat');
    expect(chat.definition.determinism).toEqual({
      reset: 'none',
      replayPrefix: 'unsafe',
      time: 'wall',
      observation: 'exact',
      actions: 'irreversible',
    });
  });

  it('declares every catalog operation with its flags', () => {
    const expected: Record<string, Record<string, boolean | string>> = {
      'chat.post': {
        eager: true,
        effects: true,
        once: true,
      },
      'chat.reply': {
        eager: true,
        effects: true,
        once: true,
      },
      'chat.history': {
        eager: true,
        sense: 'state',
      },
      'chat.channels': {},
      'chat.react': {
        effects: true,
        optional: true,
      },
      'chat.edit': {
        effects: true,
        optional: true,
      },
      'chat.delete': {
        effects: true,
        guarded: true,
        optional: true,
      },
      'chat.users': {
        optional: true,
      },
    };
    expect(Object.keys(chat.operations).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, flags] of Object.entries(expected)) {
      expect({
        name,
        flags: flagsOf(chat, name),
      }).toEqual({
        name,
        flags,
      });
    }
  });

  it('marks channel and user refs public, thread and message refs not', () => {
    const post = chat.operations['chat.post'];
    assert(post?.input instanceof z.ZodObject && post.output instanceof z.ZodObject);
    expect(profileFieldOf(post.input.shape.channel)).toMatchObject({
      refKind: 'chat.channel',
      public: true,
    });
    expect(profileFieldOf(post.output.shape.thread)).toMatchObject({
      refKind: 'chat.thread',
      public: false,
    });
    expect(profileFieldOf(post.output.shape.message)).toMatchObject({
      refKind: 'chat.message',
      public: false,
    });
    expect(profileFieldOf(ChatMessageSchema.shape.author.shape.user)).toMatchObject({
      refKind: 'chat.user',
      public: true,
    });
  });

  it('chat.post and chat.reply', () => {
    checkOperation(chat, 'chat.post', {
      input: {
        channel,
        text: '**Deploy** done',
      },
      badInput: {
        channel,
        text: '',
      },
      output: {
        message: messageRef,
        thread,
        receipt: receiptOf(),
      },
      badOutput: {
        message: messageRef,
        thread,
      },
    });
    checkOperation(chat, 'chat.reply', {
      input: {
        thread,
        text: 'On it.',
      },
      badInput: {
        thread: channel,
        text: 'x',
      },
      output: {
        message: messageRef,
        receipt: receiptOf(),
      },
      badOutput: {
        message: messageRef,
      },
    });
  });

  it('chat.history takes channel or thread, not both', () => {
    checkOperation(chat, 'chat.history', {
      input: {
        thread,
        cursor: 'c1',
        limit: 20,
      },
      badInput: {
        channel,
        thread,
      },
      output: {
        messages: [
          message,
        ],
        cursor: 'c2',
      },
      badOutput: {
        messages: [
          {
            ...message,
            time: '',
          },
        ],
      },
    });
    const history = chat.operations['chat.history'];
    expect(history?.input.safeParse({}).success).toBe(true);
    expect(
      history?.input.safeParse({
        limit: 0,
      }).success,
    ).toBe(false);
  });

  it('chat.channels and chat.users page', () => {
    checkOperation(chat, 'chat.channels', {
      input: {
        cursor: 'c1',
      },
      badInput: {
        cursor: '',
      },
      output: {
        channels: [
          {
            channel,
            name: 'deploys',
          },
        ],
      },
      badOutput: {
        channels: [
          {
            channel: thread,
            name: 'deploys',
          },
        ],
      },
    });
    checkOperation(chat, 'chat.users', {
      input: {},
      badInput: {
        cursor: '',
      },
      output: {
        users: [
          {
            user,
            name: 'Ada',
          },
        ],
        cursor: 'n',
      },
      badOutput: {
        users: [
          {
            user,
          },
        ],
      },
    });
  });

  it('chat.react, chat.edit and chat.delete', () => {
    checkOperation(chat, 'chat.react', {
      input: {
        message: messageRef,
        emoji: 'white_check_mark',
      },
      badInput: {
        message: messageRef,
        emoji: '',
      },
      output: done,
      badOutput: {},
    });
    checkOperation(chat, 'chat.edit', {
      input: {
        message: messageRef,
        text: 'fixed',
      },
      badInput: {
        message: messageRef,
      },
      output: done,
      badOutput: {},
    });
    checkOperation(chat, 'chat.delete', {
      input: {
        message: messageRef,
      },
      badInput: {
        message: thread,
      },
      output: done,
      badOutput: {},
    });
  });

  it('declares its read', () => {
    const recent = chat.reads['chat.thread.recent'];
    expect([
      recent?.look,
      recent?.sense,
    ]).toEqual([
      'effect',
      'state',
    ]);
    expect(
      ChatRecentSchema.safeParse({
        thread,
        messages: [
          message,
        ],
      }).success,
    ).toBe(true);
    expect(
      ChatRecentSchema.safeParse({
        thread: null,
        messages: [],
      }).success,
    ).toBe(true);
    expect(
      ChatRecentSchema.safeParse({
        messages: [],
      }).success,
    ).toBe(false);
  });

  it('declares its events durable, on state, threaded by thread', () => {
    const expected: Record<string, boolean> = {
      'chat.message.created': false,
      'chat.message.updated': true,
      'chat.reaction.added': true,
    };
    expect(Object.keys(chat.events).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, optional] of Object.entries(expected)) {
      const event = chat.events[name];
      assert(event);
      expect({
        name,
        sense: String(event.sense),
        replay: event.replay,
        thread: event.thread,
        optional: event.required === false,
      }).toEqual({
        name,
        sense: 'state',
        replay: 'durable',
        thread: 'thread',
        optional,
      });
    }
    const created = chat.events['chat.message.created'];
    assert(created);
    expect(created.payload.safeParse(message).success).toBe(true);
    expect(
      created.payload.safeParse({
        ...message,
        author: {},
      }).success,
    ).toBe(false);
    expect(
      created.arguments?.safeParse({
        channel,
        thread,
        mentionsAgent: true,
      }).success,
    ).toBe(true);
    expect(
      created.arguments?.safeParse({
        channel: thread,
      }).success,
    ).toBe(false);
    const reaction = chat.events['chat.reaction.added'];
    expect(
      reaction?.payload.safeParse({
        message: messageRef,
        thread,
        channel,
        user,
        emoji: 'eyes',
      }).success,
    ).toBe(true);
    expect(
      reaction?.payload.safeParse({
        message: messageRef,
        thread,
        channel,
        user,
        emoji: '',
      }).success,
    ).toBe(false);
  });
});
