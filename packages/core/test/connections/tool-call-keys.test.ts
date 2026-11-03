/**
 * A connection tool's idempotency key (spec 35 § Durability) is
 * `<execution>:tool:<callId>` whether the model called it through `callModel`
 * or an ACP agent called it through the tool bridge. A call with no id — a
 * step running the tool directly, or an agent call nobody named — takes one
 * from the step and the call's order, so two equal calls get two keys and a
 * resumed step gets the same ones.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { Context, ContextData, Step, Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { createInMemoryConnection } from '../../src/connections/in-memory-connection';
import { AgentHarness } from '../../src/harness/agent-harness';
import { AcpEventBridge } from '../../src/interpreter/acp-events';
import type { AcpToolBinding } from '../../src/interpreter/acp-tools';
import { AcpToolRunner } from '../../src/interpreter/acp-tools';
import { executeToolCall } from '../../src/runtime/tool-call';

//#region Fixtures

/** A harness whose one connection answers `key` with the idempotency key it was sent. */
function keyHarness(): AgentHarness {
  return new AgentHarness({
    name: 'keys',
    params: {},
    connections: {
      keys: createInMemoryConnection({
        operations: {
          key: {
            inputSchema: {
              type: 'object',
            },
            run: (_args, call) => call.idempotencyKey,
          },
        },
      }),
    },
  });
}

/** Runs `work` inside a root run, with the turn's tool set built. */
async function inRun<T>(
  harness: AgentHarness,
  work: (ctx: Context, tools: ReadonlyArray<Tool>) => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  const root = frameworkCast<Step<ContextData, string, string>>({
    kind: 'runCode',
    id: 'host',
    execute: async (_input: string, ctx: Context) => {
      out = await work(ctx, ctx.unifiedTools ?? []);
      return 'ok';
    },
  });
  await harness.run(root, 'go', harness.createContext());
  assert(out !== undefined);
  return out;
}

//#endregion

describe('connection tool idempotency keys', () => {
  test('callModel and the ACP bridge key a call the same way: <execution>:tool:<callId>', async () => {
    const harness = keyHarness();
    const keys = await inRun(harness, async (ctx, tools) => {
      const model = await executeToolCall({
        toolName: 'keys_key',
        args: {},
        tools,
        context: ctx,
        harness: ctx.harness,
        callId: 'call_7',
      });
      const runner = new AcpToolRunner(tools.filter((tool) => tool.name === 'keys_key'));
      runner.bind({
        stepId: 'agent',
        ctx: frameworkCast<Context<ContextData>>(ctx),
        events: new AcpEventBridge(
          frameworkCast({
            id: 'agent',
          }),
          'fake',
          frameworkCast<Context<ContextData>>(ctx),
        ),
        fail: (error) => {
          throw error;
        },
      });
      const bridged = await runner.call({
        name: 'keys_key',
        args: {},
        agentCallId: 'call_7',
        signal: new AbortController().signal,
      });
      return {
        model: model.output,
        bridged: bridged.output,
        expected: `${ctx.id}:tool:call_7`,
      };
    });
    expect(keys.model).toContain(keys.expected);
    expect(keys.bridged).toBe(keys.model);
  });

  test('two equal calls with no call id get two keys, and a rerun of the step gets the same two', async () => {
    const keysOfRun = (): Promise<string[]> =>
      inRun(keyHarness(), async (ctx, tools) => {
        const outputs: string[] = [];
        for (const _ of [
          1,
          2,
        ]) {
          const result = await executeToolCall({
            toolName: 'keys_key',
            args: {},
            tools,
            context: ctx,
            harness: ctx.harness,
          });
          outputs.push(callIdIn(result.output));
        }
        return outputs;
      });
    const first = await keysOfRun();
    expect(first[0]).toMatch(/^derived-[0-9a-f]{8}$/);
    expect(first[0]).not.toBe(first[1]);
    expect(await keysOfRun()).toEqual(first);
  });

  test('the bridge gives unnamed agent calls ids from the step and order, the same on a rerun', async () => {
    const idsOfRun = (): Promise<string[]> =>
      inRun(keyHarness(), async (ctx, tools) => {
        const runner = boundRunner(ctx, tools);
        const outputs: string[] = [];
        for (const _ of [
          1,
          2,
        ]) {
          const result = await runner.call({
            name: 'keys_key',
            args: {},
            signal: new AbortController().signal,
          });
          outputs.push(callIdIn(result.output));
        }
        return outputs;
      });
    const first = await idsOfRun();
    expect(first[0]).toMatch(/^derived-[0-9a-f]{8}$/);
    expect(first[0]).not.toBe(first[1]);
    expect(await idsOfRun()).toEqual(first);
  });

  test('the bridge refuses an agent call id already used in the session', async () => {
    const results = await inRun(keyHarness(), async (ctx, tools) => {
      const runner = boundRunner(ctx, tools);
      const call = () =>
        runner.call({
          name: 'keys_key',
          args: {},
          agentCallId: 'call_7',
          signal: new AbortController().signal,
        });
      const first = await call();
      runner.unbind();
      runner.bind(bindingFor(ctx));
      return [
        first,
        await call(),
      ];
    });
    expect(results[0]?.isError).toBe(false);
    expect(results[1]).toEqual({
      output: "Error: tool call id 'call_7' was already used in this session.",
      isError: true,
    });
  });
});

//#region Helpers

/** The call id inside an idempotency key `<execution>:tool:<callId>`. */
function callIdIn(key: string): string {
  const id = key.split(':tool:')[1];
  assert(id !== undefined, `not a tool key: ${key}`);
  return id;
}

function bindingFor(ctx: Context): AcpToolBinding {
  const stepCtx = frameworkCast<Context<ContextData>>(ctx);
  return {
    stepId: 'agent',
    ctx: stepCtx,
    events: new AcpEventBridge(
      frameworkCast({
        id: 'agent',
      }),
      'fake',
      stepCtx,
    ),
    fail: (error) => {
      throw error;
    },
  };
}

function boundRunner(ctx: Context, tools: ReadonlyArray<Tool>): AcpToolRunner {
  const runner = new AcpToolRunner(tools.filter((tool) => tool.name === 'keys_key'));
  runner.bind(bindingFor(ctx));
  return runner;
}

//#endregion
