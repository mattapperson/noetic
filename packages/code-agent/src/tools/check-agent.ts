/**
 * `checkAgent` tool — poll the status of a previously-launched teammate.
 *
 * Mirrors the shape of `examples/delegate-tools.ts:createCheckTool`. Useful
 * when the parent wants to explicitly check on a background agent without
 * waiting for the auto-injected completion notice.
 */

import type { Tool } from '@noetic-tools/core';
import { tool } from '@noetic-tools/core';
import { z } from 'zod';
import type { TeammateRegistry } from '../agents/registry-runtime.js';

//#region Types

interface CreateCheckAgentToolArgs {
  teammates: TeammateRegistry;
}

const CheckAgentInputSchema = z.object({
  agentId: z
    .string()
    .min(1)
    .describe('Agent id returned by a prior `agent` call (status: async_launched).'),
});

const CheckAgentOutputSchema = z.object({
  status: z.enum([
    'running',
    'completed',
    'failed',
    'unknown',
  ]),
  result: z.string().optional(),
  error: z.string().optional(),
});

type CheckAgentOutput = z.infer<typeof CheckAgentOutputSchema>;

//#endregion

//#region Tool factory

export function createCheckAgentTool(args: CreateCheckAgentToolArgs): Tool {
  return tool({
    name: 'checkAgent',
    description:
      'Check the status of a teammate launched in the background. Returns running/completed/failed plus the result or error when settled.',
    input: CheckAgentInputSchema,
    output: CheckAgentOutputSchema,
    execute: async (input): Promise<CheckAgentOutput> => {
      const handle = args.teammates.getById(input.agentId);
      if (handle === undefined) {
        return {
          status: 'unknown',
        };
      }
      return {
        status: handle.status,
        result: handle.result,
        error: handle.error,
      };
    },
  });
}

//#endregion
