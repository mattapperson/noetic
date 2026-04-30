/**
 * `sendMessage` tool — append a message to a named teammate's inbound queue.
 *
 * The teammate consumes its inbound queue via `teammateInboundLayer` on each
 * recall, so the message lands in the child's next turn as an
 * `<inbound-message>` block. No `Channel<T>` is involved — the queue is a
 * plain array on `TeammateRegistry`, mirroring the parent-side notice queue.
 */

import type { Tool } from '@noetic/core';
import { tool } from '@noetic/core';
import { z } from 'zod';
import type { TeammateRegistry } from '../agents/registry-runtime.js';

//#region Types

interface CreateSendMessageToolArgs {
  teammates: TeammateRegistry;
}

const SendMessageInputSchema = z.object({
  to: z
    .string()
    .min(1)
    .describe('Name of the teammate to message (set when the agent was spawned).'),
  message: z.string().min(1).describe('Message body to deliver to the teammate.'),
});

const SendMessageOutputSchema = z.object({
  status: z.enum([
    'delivered',
    'unknown_teammate',
  ]),
  to: z.string(),
});

type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

//#endregion

//#region Tool factory

export function createSendMessageTool(args: CreateSendMessageToolArgs): Tool {
  return tool({
    name: 'sendMessage',
    description:
      'Send a message to a named teammate spawned via `agent` with a `name`. Returns immediately; the teammate sees the message as an `<inbound-message>` block on its next turn.',
    input: SendMessageInputSchema,
    output: SendMessageOutputSchema,
    execute: async (input): Promise<SendMessageOutput> => {
      const delivered = args.teammates.postInbound(input.to, input.message);
      return {
        status: delivered ? 'delivered' : 'unknown_teammate',
        to: input.to,
      };
    },
  });
}

//#endregion
