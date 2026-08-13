/**
 * JSON Workflow Runtime hardening (workflow-slice review W1–W6).
 *
 * W1: `invokeTool` nodes must pass the same gates as the model tool-loop —
 *     argument validation, steering, and the real layer bridge — instead of
 *     calling `tool.execute` directly (which was a validation bypass
 *     reachable from model-generated documents).
 * W2: node ids must be unique within a document scope (`DUPLICATE_NODE_ID`) —
 *     the step registry is latest-wins and the resume ledger keys replay by
 *     id-derived paths, so collisions silently corrupt both.
 * W3: dynamic inParallel template hydration is cached per index — repeated
 *     invocations must not re-hydrate (and re-register) per item per call.
 * W5: conditional routes support `matchMode: 'exact'`; substring stays default.
 * W6: hydration failures feed the dynamicWorkflow revision loop.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import type { Tool } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import type { WorkflowNode } from '../../src/schemas/workflow';
import { validateWorkflow } from '../../src/schemas/workflow';
import { makeMockContext } from '../_helpers';

function makeCtx(tools: Map<string, Tool>): HydrationContext {
  return {
    tools,
    executeStep: frameworkCast<HydrationContext['executeStep']>(
      async (s: unknown, input: unknown, ctx: unknown) => {
        const anyStep = frameworkCast<{
          kind: string;
          execute?: (input: unknown, ctx: unknown) => Promise<unknown>;
        }>(s);
        if (anyStep.execute) {
          return anyStep.execute(input, ctx);
        }
        return input;
      },
    ),
  };
}

describe('W1 — invokeTool nodes pass the model tool-loop gates', () => {
  const strictTool = tool({
    name: 'strict',
    description: 'x',
    input: z.object({
      n: z.number(),
    }),
    output: z.string(),
    execute: async (args: { n: number }) => `ran:${args.n}`,
  });

  function hydrateStrict(node: WorkflowNode): ReturnType<typeof hydrateNode> {
    return hydrateNode(
      node,
      makeCtx(
        new Map([
          [
            'strict',
            frameworkCast<Tool>(strictTool),
          ],
        ]),
      ),
    );
  }

  test('invalid args are rejected before execute (validation gate)', async () => {
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'bad-args',
      toolName: 'strict',
      args: {
        n: 'not-a-number',
      },
    };
    const hydrated = hydrateStrict(node);
    assert(hydrated.kind === 'runCode');
    let thrown: unknown;
    try {
      await hydrated.execute('', makeMockContext());
    } catch (e) {
      thrown = e;
    }
    assert(isNoeticConfigError(thrown));
    expect(thrown.code).toBe('WORKFLOW_TOOL_CALL_FAILED');
    expect(thrown.message).toContain('invalid arguments');
  });

  test('valid args execute and return the tool result', async () => {
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'good-args',
      toolName: 'strict',
      args: {
        n: 7,
      },
    };
    const hydrated = hydrateStrict(node);
    assert(hydrated.kind === 'runCode');
    const out = await hydrated.execute('', makeMockContext());
    expect(String(out)).toContain('ran:7');
  });

  test('a denied steering decision surfaces as WORKFLOW_TOOL_CALL_FAILED', async () => {
    let executed = 0;
    const guarded = tool({
      name: 'guarded',
      description: 'x',
      input: z.object({}),
      output: z.string(),
      execute: async () => {
        executed++;
        return 'should-not-run';
      },
    });
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'guarded-node',
      toolName: 'guarded',
      args: {},
    };
    const hydrated = hydrateNode(
      node,
      makeCtx(
        new Map([
          [
            'guarded',
            frameworkCast<Tool>(guarded),
          ],
        ]),
      ),
    );
    assert(hydrated.kind === 'runCode');
    // A layer present on the context routes the call through
    // harness.beforeToolCall — the mock harness denies, so nothing runs.
    const ctx = makeMockContext({
      layers: [
        frameworkCast<never>({
          id: 'deny-everything',
        }),
      ],
      harness: frameworkCast<never>({
        ...makeMockContext().harness,
        beforeToolCall: async () => ({
          action: 'deny',
          guidance: 'not allowed here',
        }),
      }),
    });
    let thrown: unknown;
    try {
      await hydrated.execute('', ctx);
    } catch (e) {
      thrown = e;
    }
    assert(isNoeticConfigError(thrown));
    expect(thrown.code).toBe('WORKFLOW_TOOL_CALL_FAILED');
    expect(thrown.message).toContain('denied');
    expect(executed).toBe(0);
  });

  test('the transcript records a function_call AND its function_call_output', async () => {
    const node: WorkflowNode = {
      kind: 'invokeTool',
      id: 'paired',
      toolName: 'strict',
      args: {
        n: 1,
      },
    };
    const hydrated = hydrateStrict(node);
    assert(hydrated.kind === 'runCode');
    const ctx = makeMockContext();
    await hydrated.execute('', ctx);
    const types = ctx.itemLog.items.map((i) => i.type);
    expect(types).toContain('function_call');
    expect(types).toContain('function_call_output');
  });
});

describe('W2 — duplicate node ids are rejected at validation', () => {
  test('validateWorkflow throws DUPLICATE_NODE_ID on a collision', () => {
    let thrown: unknown;
    try {
      validateWorkflow({
        version: 1,
        root: {
          kind: 'sequence',
          id: 'root',
          steps: [
            {
              kind: 'callModel',
              id: 'step1',
              instructions: 'a',
            },
            {
              kind: 'callModel',
              id: 'step1',
              instructions: 'b',
            },
          ],
        },
      });
    } catch (e) {
      thrown = e;
    }
    assert(isNoeticConfigError(thrown));
    expect(thrown.code).toBe('DUPLICATE_NODE_ID');
    expect(thrown.message).toContain('step1');
  });

  test('unique ids pass', () => {
    const doc = validateWorkflow({
      version: 1,
      root: {
        kind: 'sequence',
        id: 'root',
        steps: [
          {
            kind: 'callModel',
            id: 'a',
            instructions: 'a',
          },
          {
            kind: 'callModel',
            id: 'b',
            instructions: 'b',
          },
        ],
      },
    });
    expect(doc.root.id).toBe('root');
  });

  test('an inline subflow may reuse an outer id (its ids are suffixed at hydration)', () => {
    const doc = validateWorkflow({
      version: 1,
      root: {
        kind: 'sequence',
        id: 'root',
        steps: [
          {
            kind: 'callModel',
            id: 'work',
            instructions: 'outer',
          },
          {
            kind: 'subflow',
            id: 'nested',
            document: {
              version: 1,
              root: {
                kind: 'callModel',
                id: 'work',
                instructions: 'inner',
              },
            },
          },
        ],
      },
    });
    expect(doc.root.id).toBe('root');
  });

  test('a collision INSIDE an inline subflow document is still rejected', () => {
    let thrown: unknown;
    try {
      validateWorkflow({
        version: 1,
        root: {
          kind: 'subflow',
          id: 'nested',
          document: {
            version: 1,
            root: {
              kind: 'sequence',
              id: 'inner-root',
              steps: [
                {
                  kind: 'callModel',
                  id: 'dup',
                  instructions: 'a',
                },
                {
                  kind: 'callModel',
                  id: 'dup',
                  instructions: 'b',
                },
              ],
            },
          },
        },
      });
    } catch (e) {
      thrown = e;
    }
    assert(isNoeticConfigError(thrown));
    expect(thrown.code).toBe('DUPLICATE_NODE_ID');
    expect(thrown.message).toContain('dup');
  });
});

describe('W3 — dynamic inParallel caches per-index hydration across invocations', () => {
  test('repeated invocations reuse the same per-index wrapper ids', () => {
    const counting = tool({
      name: 'count',
      description: 'x',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    });
    const node: WorkflowNode = {
      kind: 'inParallel',
      id: 'dyn',
      mode: 'all',
      each: {
        kind: 'invokeTool',
        id: 'body',
        toolName: 'count',
        args: {},
      },
      merge: 'concat',
    };
    const hydrated = hydrateNode(
      node,
      makeCtx(
        new Map([
          [
            'count',
            frameworkCast<Tool>(counting),
          ],
        ]),
      ),
    );
    assert(hydrated.kind === 'inParallel');
    const paths = frameworkCast<{
      paths: (input: string) => Array<{
        id: string;
      }>;
    }>(hydrated).paths;
    const paths1 = paths('[1,2,3]');
    const paths2 = paths('[4,5,6]');
    expect(paths1.map((p) => p.id)).toEqual([
      'dyn-item-0',
      'dyn-item-1',
      'dyn-item-2',
    ]);
    // Same wrapper ids on the second invocation — bounded registry churn.
    expect(paths2.map((p) => p.id)).toEqual(paths1.map((p) => p.id));
  });
});

describe('W5 — conditional matchMode', () => {
  function conditionalNode(matchMode?: 'substring' | 'exact'): WorkflowNode {
    return {
      kind: 'conditional',
      id: 'router',
      routes: [
        {
          match: 'cat',
          ...(matchMode
            ? {
                matchMode,
              }
            : {}),
          target: {
            kind: 'callModel',
            id: 'cat-target',
            instructions: 'cat',
          },
        },
      ],
      default: {
        kind: 'callModel',
        id: 'default-target',
        instructions: 'default',
      },
    };
  }

  function routeOf(matchMode?: 'substring' | 'exact'): (input: string) => {
    id: string;
  } | null {
    const hydrated = hydrateNode(conditionalNode(matchMode), makeCtx(new Map()));
    assert(hydrated.kind === 'conditional');
    return frameworkCast<{
      route: (input: string) => {
        id: string;
      } | null;
    }>(hydrated).route;
  }

  test("default substring: route 'cat' fires for 'concatenate'", () => {
    expect(routeOf()('concatenate')?.id).toBe('cat-target');
  });

  test("exact: route 'cat' does NOT fire for 'concatenate', does for ' Cat '", () => {
    const route = routeOf('exact');
    expect(route('concatenate')?.id).toBe('default-target');
    expect(route(' Cat ')?.id).toBe('cat-target');
  });
});

describe('W6 — dynamicWorkflow feeds hydration errors to the revision loop', () => {
  test('a planner emitting an unknown tool ref gets error feedback and can repair', async () => {
    const { dynamicWorkflow } = await import('../../src/builders/dynamic-workflow');
    const { AgentHarness } = await import('../../src/harness/agent-harness');

    const realTool = tool({
      name: 'real-tool',
      description: 'exists',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'done',
    });

    // Planner script: first attempt references a tool that is NOT registered
    // (valid document, hydration fails); second attempt repairs it. Without
    // hydration-error feedback the first failure escapes the loop and the
    // repair never happens.
    const attempts: string[] = [];
    let call = 0;
    const docs = [
      JSON.stringify({
        version: 1,
        root: {
          kind: 'invokeTool',
          id: 't1',
          toolName: 'ghost-tool',
          args: {},
        },
      }),
      JSON.stringify({
        version: 1,
        root: {
          kind: 'invokeTool',
          id: 't1',
          toolName: 'real-tool',
          args: {},
        },
      }),
    ];
    const harness = new AgentHarness(
      frameworkCast<never>({
        name: 'w6-test',
        params: {},
        _testCallModel: async (request: { instructions?: string }) => {
          attempts.push(request.instructions ?? '');
          const text = docs[Math.min(call++, docs.length - 1)] ?? '';
          return {
            items: [
              {
                id: `r-${call}`,
                status: 'completed',
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text,
                  },
                ],
              },
            ],
            usage: {
              inputTokens: 0,
              outputTokens: 1,
            },
          };
        },
      }),
    );

    const wf = dynamicWorkflow({
      tools: [
        frameworkCast<Tool>(realTool),
      ],
    });
    const ctx = harness.createContext();
    const out = await harness.run(frameworkCast<never>(wf), 'do the thing', ctx);
    expect(String(out)).toContain('done');
    // The second planner prompt must carry the first hydration failure back.
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toContain('ghost-tool');
    expect(attempts[1]).toContain('Previous attempt failed');
  });
});
