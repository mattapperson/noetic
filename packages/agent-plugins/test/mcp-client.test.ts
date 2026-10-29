import { describe, expect, test } from 'bun:test';
import type { CallOutcome, CallResult } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { McpSession } from '../src/mcp-client';
import { callMcpTool } from '../src/mcp-client';

//#region Helpers

/** A session whose one tool starts a long operation that never ends on its own. */
function hangingSession(): McpSession {
  const connection = {
    async call(): Promise<CallResult> {
      return {
        status: 'task',
        taskId: 'forever',
      };
    },
    tasks: {
      result(
        _taskId: string,
        opts: {
          signal: AbortSignal;
        },
      ): Promise<CallOutcome> {
        return new Promise((_resolve, reject) => {
          if (opts.signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    },
  };
  return frameworkCast<McpSession>({
    key: 'plugin/server',
    connection,
    tools: [],
    close: async () => undefined,
  });
}

//#endregion

describe('callMcpTool', () => {
  test("the caller's signal cancels a long operation that never ends", async () => {
    const controller = new AbortController();
    const pending = callMcpTool({
      session: hangingSession(),
      tool: 'build',
      args: {},
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(String(outcome.content)).toContain('aborted');
  });
});
