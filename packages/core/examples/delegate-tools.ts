/**
 * Shared tool factories for sync and async sub-agent delegation.
 *
 * Used by the sync-delegate, async-delegate, and dynamic-delegate examples.
 */

import type { ContextMemory, MemoryLayer } from '@noetic-tools/memory';
import type {
  AgentHarnessContract,
  Channel,
  DetachedHandle,
  DetachedStatus,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { z } from 'zod';
import { spawn } from '../src/builders/spawn-builder';
import { step } from '../src/builders/step-builders';
import { tool } from '../src/builders/tool-builder';
import { react } from '../src/patterns/react';

//#region Types

interface SubAgentConfig {
  id: string;
  model: string;
  instructions: string;
  tools?: Tool[];
  memory?: MemoryLayer[];
}

export type SubAgentResolver = (task: string) => SubAgentConfig;

type CheckToolResult = {
  status:
    | typeof DetachedStatus.Running
    | typeof DetachedStatus.Completed
    | typeof DetachedStatus.Failed
    | 'not_found';
  result: string | undefined;
};

//#endregion

//#region Shared Helpers

function buildSubAgentStep(id: string): ReturnType<typeof step.llm<ContextMemory, string, string>> {
  return step.llm<ContextMemory, string, string>({
    id,
    model: 'openai/gpt-4o',
    instructions: 'You are a research assistant. Answer concisely.',
  });
}

function buildConfiguredSubAgentStep(
  config: SubAgentConfig,
): ReturnType<typeof spawn<ContextMemory, string, string>> {
  const llmStep = step.llm<ContextMemory, string, string>({
    id: `${config.id}-llm`,
    model: config.model,
    instructions: config.instructions,
    tools: config.tools,
  });

  const body = config.tools?.length
    ? react({
        model: config.model,
        instructions: config.instructions,
        tools: config.tools,
        maxSteps: 10,
      })
    : llmStep;

  return spawn({
    id: config.id,
    child: body,
    memory: config.memory,
  });
}

/** Notifies the inbox channel when a detached handle settles. Intentionally fire-and-forget. */
function notifyInboxOnSettlement(opts: {
  handle: DetachedHandle<string>;
  harness: AgentHarnessContract;
  inbox: Channel<string>;
  ctx: ToolExecutionContext;
  handles: Map<string, DetachedHandle<string>>;
}): void {
  void opts.handle.await().then(
    (result) => {
      opts.handles.delete(opts.handle.id);
      opts.harness.send(
        opts.inbox,
        `[Sub-agent ${opts.handle.id} completed] ${result}`,
        opts.ctx.ctx,
      );
    },
    (err: unknown) => {
      opts.handles.delete(opts.handle.id);
      const message = err instanceof Error ? err.message : String(err);
      opts.harness.send(
        opts.inbox,
        `[Sub-agent ${opts.handle.id} failed] ${message}`,
        opts.ctx.ctx,
      );
    },
  );
}

//#endregion

//#region Tool Factories

/** Sync tool: blocks until sub-agent completes, returns result as tool output. */
export function createSyncDelegateTool(): Tool {
  return tool({
    name: 'delegate',
    description: 'Run a sub-agent and wait for its result. Use when you need the answer now.',
    input: z.object({
      task: z.string().describe('The task to delegate'),
    }),
    output: z.string(),
    execute: async (args, toolCtx) => {
      const child = buildSubAgentStep('sync-sub-agent');
      const spawnStep = spawn({
        id: 'sync-delegate-spawn',
        child,
      });
      return toolCtx.harness.run(spawnStep, args.task, toolCtx.ctx);
    },
  });
}

/** Async tool: launches sub-agent in background, notifies via inbox on completion. */
export function createAsyncLaunchTool(opts: {
  inbox: Channel<string>;
  handles: Map<string, DetachedHandle<string>>;
}): Tool {
  return tool({
    name: 'launch_agent',
    description:
      'Launch a sub-agent in the background. Use when you can continue other work while it runs.',
    input: z.object({
      task: z.string().describe('The task for the background sub-agent'),
    }),
    output: z.object({
      agentId: z.string(),
    }),
    execute: async (args, toolCtx) => {
      const child = buildSubAgentStep('async-sub-agent');
      const handle = toolCtx.harness.detachedSpawn(child, args.task, toolCtx.ctx);
      opts.handles.set(handle.id, handle);

      notifyInboxOnSettlement({
        handle,
        harness: toolCtx.harness,
        inbox: opts.inbox,
        ctx: toolCtx,
        handles: opts.handles,
      });

      return {
        agentId: handle.id,
      };
    },
  });
}

/** Configurable sync tool: uses a SubAgentResolver to build sub-agents with custom config. */
export function createConfigurableDelegateTool(resolver: SubAgentResolver): Tool {
  return tool({
    name: 'delegate',
    description: 'Run a sub-agent and wait for its result. Use when you need the answer now.',
    input: z.object({
      task: z.string().describe('The task to delegate'),
    }),
    output: z.string(),
    execute: async (args, toolCtx) => {
      const config = resolver(args.task);
      const spawnStep = buildConfiguredSubAgentStep(config);
      return toolCtx.harness.run(spawnStep, args.task, toolCtx.ctx);
    },
  });
}

/** Configurable async tool: uses a SubAgentResolver for background sub-agents. */
export function createConfigurableAsyncLaunchTool(opts: {
  resolver: SubAgentResolver;
  inbox: Channel<string>;
  handles: Map<string, DetachedHandle<string>>;
}): Tool {
  return tool({
    name: 'launch_agent',
    description:
      'Launch a sub-agent in the background. Use when you can continue other work while it runs.',
    input: z.object({
      task: z.string().describe('The task for the background sub-agent'),
    }),
    output: z.object({
      agentId: z.string(),
    }),
    execute: async (args, toolCtx) => {
      const config = opts.resolver(args.task);
      const spawnStep = buildConfiguredSubAgentStep(config);
      const handle = toolCtx.harness.detachedSpawn(spawnStep, args.task, toolCtx.ctx);
      opts.handles.set(handle.id, handle);

      notifyInboxOnSettlement({
        handle,
        harness: toolCtx.harness,
        inbox: opts.inbox,
        ctx: toolCtx,
        handles: opts.handles,
      });

      return {
        agentId: handle.id,
      };
    },
  });
}

/** Check tool: reports the status of a previously launched sub-agent. */
export function createCheckTool(handles: Map<string, DetachedHandle<string>>): Tool {
  return tool({
    name: 'check_agent',
    description: 'Check the status of a launched sub-agent.',
    input: z.object({
      agentId: z.string().describe('The agent ID returned by launch_agent'),
    }),
    output: z.object({
      status: z.string(),
      result: z.string().optional(),
    }),
    execute: async (args, _toolCtx): Promise<CheckToolResult> => {
      const handle = handles.get(args.agentId);
      if (!handle) {
        return {
          status: 'not_found',
          result: undefined,
        };
      }
      return {
        status: handle.status,
        result: handle.result,
      };
    },
  });
}

//#endregion
