/**
 * Shared tool factories for sync and async sub-agent delegation.
 *
 * Used by the sync-delegate, async-delegate, and dynamic-delegate examples.
 */
import { z } from 'zod';
import { spawn } from '../src/builders/spawn-builder';
import { step } from '../src/builders/step-builders';
import type { InMemoryRuntime } from '../src/runtime/in-memory-runtime';
import type { Channel } from '../src/types/channel';
import type { Tool } from '../src/types/common';
import type { Context } from '../src/types/context';
import type { DetachedHandle } from '../src/types/detached';
import { DetachedStatus } from '../src/types/detached';

//#region Types

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

function buildSubAgentStep(id: string): ReturnType<typeof step.llm<string, string>> {
  return step.llm<string, string>({
    id,
    model: 'gpt-4o',
    system: 'You are a research assistant. Answer concisely.',
  });
}

/** Notifies the inbox channel when a detached handle settles. Intentionally fire-and-forget. */
function notifyInboxOnSettlement(opts: {
  handle: DetachedHandle<string>;
  runtime: InMemoryRuntime;
  inbox: Channel<string>;
  ctx: Context;
  handles: Map<string, DetachedHandle<string>>;
}): void {
  void opts.handle.await().then(
    (result) => {
      opts.handles.delete(opts.handle.id);
      opts.runtime.send(opts.inbox, `[Sub-agent ${opts.handle.id} completed] ${result}`, opts.ctx);
    },
    (err: unknown) => {
      opts.handles.delete(opts.handle.id);
      const message = err instanceof Error ? err.message : String(err);
      opts.runtime.send(opts.inbox, `[Sub-agent ${opts.handle.id} failed] ${message}`, opts.ctx);
    },
  );
}

//#endregion

//#region Tool Factories

/** Sync tool: blocks until sub-agent completes, returns result as tool output. */
export function createSyncDelegateTool(runtime: InMemoryRuntime): Tool {
  return {
    name: 'delegate',
    description: 'Run a sub-agent and wait for its result. Use when you need the answer now.',
    input: z.object({
      task: z.string().describe('The task to delegate'),
    }),
    output: z.string(),
    execute: async (args: { task: string }): Promise<string> => {
      const child = buildSubAgentStep('sync-sub-agent');
      const spawnStep = spawn({
        id: 'sync-delegate-spawn',
        child,
      });
      const ctx = runtime.createContext();
      return runtime.execute(spawnStep, args.task, ctx);
    },
  };
}

/** Async tool: launches sub-agent in background, notifies via inbox on completion. */
export function createAsyncLaunchTool(opts: {
  runtime: InMemoryRuntime;
  inbox: Channel<string>;
  handles: Map<string, DetachedHandle<string>>;
}): Tool {
  return {
    name: 'launch_agent',
    description:
      'Launch a sub-agent in the background. Use when you can continue other work while it runs.',
    input: z.object({
      task: z.string().describe('The task for the background sub-agent'),
    }),
    output: z.object({
      agentId: z.string(),
    }),
    execute: async (args: {
      task: string;
    }): Promise<{
      agentId: string;
    }> => {
      const child = buildSubAgentStep('async-sub-agent');
      const ctx = opts.runtime.createContext();
      const handle = opts.runtime.detachedSpawn(child, args.task, ctx);
      opts.handles.set(handle.id, handle);

      notifyInboxOnSettlement({
        handle,
        runtime: opts.runtime,
        inbox: opts.inbox,
        ctx,
        handles: opts.handles,
      });

      return {
        agentId: handle.id,
      };
    },
  };
}

/** Check tool: reports the status of a previously launched sub-agent. */
export function createCheckTool(handles: Map<string, DetachedHandle<string>>): Tool {
  return {
    name: 'check_agent',
    description: 'Check the status of a launched sub-agent.',
    input: z.object({
      agentId: z.string().describe('The agent ID returned by launch_agent'),
    }),
    output: z.object({
      status: z.string(),
      result: z.string().optional(),
    }),
    execute: async (args: { agentId: string }): Promise<CheckToolResult> => {
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
  };
}

//#endregion
