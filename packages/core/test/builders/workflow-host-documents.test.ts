// What a host needs to compile its own flow format into a JSON workflow document
// (spec 26): schema output and the harness model on `callModel`, expressions in
// `invokeTool` args, `$runs`, results keyed by branch, and failing a flow from a
// node with the error intact.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  CallModelRequest,
  Step,
  Tool,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { callModel } from '../../src/builders/step-builders';
import { hydrateWorkflow } from '../../src/builders/workflow-source';
import { expressionErrors } from '../../src/expression/check';
import { AgentHarness } from '../../src/harness/agent-harness';
import { flowVersionOf } from '../../src/harness/flow-version';
import { buildTextFormat } from '../../src/harness/model-request';
import { execute } from '../../src/interpreter/execute';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { WorkflowDocumentSchema } from '../../src/schemas/workflow';
import { makeLLMResponse } from '../_helpers';
import { FakeRegistry, harnessWith } from '../steps-connections/_helpers';

//#region Helpers

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
    },
    urgent: {
      type: 'boolean',
    },
  },
  required: [
    'title',
    'urgent',
  ],
  additionalProperties: false,
};

function doc(root: WorkflowNode, connections?: WorkflowDocument['connections']): WorkflowDocument {
  return {
    version: 1,
    ...(connections
      ? {
          connections,
        }
      : {}),
    root,
  };
}

/** A harness whose model answers each request with `answer(request)`, noting the requests. */
function modelHarness(
  answer: (request: CallModelRequest) => string,
  model?: string,
): {
  harness: AgentHarness;
  requests: CallModelRequest[];
} {
  const requests: CallModelRequest[] = [];
  const harness = new AgentHarness({
    name: 'host-documents',
    params: {},
    model,
    _testCallModel: async (request) => {
      requests.push(request);
      return makeLLMResponse(answer(request));
    },
  });
  return {
    harness,
    requests,
  };
}

/** Hydrates `document` and runs it on `harness` as a host would. */
function run(
  harness: AgentHarness,
  document: WorkflowDocument,
  opts: {
    input?: string;
    tools?: Tool[];
  } = {},
): Promise<unknown> {
  const root = hydrateWorkflow(WorkflowDocumentSchema.parse(document), {
    tools: new Map(
      (opts.tools ?? []).map((tool) => [
        tool.name,
        tool,
      ]),
    ),
    executeStep: execute,
  });
  return harness.run(root, opts.input ?? '', harness.createContext());
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable('expected a failure'),
    (error: unknown) => error,
  );
}

/** The first error in a `step_failed` chain that is not itself a step failure. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

class HostError extends Error {
  readonly node: string;

  constructor(node: string) {
    super(`Node '${node}' ran out of tries.`);
    this.node = node;
  }
}

/** A tool that notes the args of each call and echoes them back. */
function echoTool(calls: unknown[]): Tool {
  return {
    name: 'echo',
    description: 'Echoes its args.',
    input: z.record(z.string(), z.unknown()),
    output: z.unknown(),
    execute: async (args: unknown) => {
      calls.push(args);
      return args;
    },
  };
}

const failTool: Tool = {
  name: 'fail',
  description: 'Fails the flow.',
  input: z.object({
    node: z.string(),
  }),
  output: z.never(),
  execute: async (args: unknown) => {
    throw new HostError(
      z
        .object({
          node: z.string(),
        })
        .parse(args).node,
    );
  },
};

//#endregion

describe('callModel output schema', () => {
  const triage: WorkflowNode = {
    kind: 'callModel',
    id: 'triage',
    model: 'test/model',
    instructions: 'Read the ticket.',
    output: {
      schema: TICKET_SCHEMA,
    },
  };

  it('holds the model to the schema and gives the parsed value', async () => {
    const { harness, requests } = modelHarness(() => '{"title":"Login fails","urgent":true}');
    const output = await run(harness, doc(triage));
    expect(output).toEqual({
      title: 'Login fails',
      urgent: true,
    });
    assert(requests[0]?.outputSchema);
    // The model is sent the schema as the document wrote it.
    const sent = buildTextFormat(requests[0].outputSchema, requests[0].outputJsonSchema);
    expect(sent.format.schema).toEqual(TICKET_SCHEMA);
  });

  it('lets a later node read the parsed fields from $steps', async () => {
    const { harness } = modelHarness(() => '{"title":"Login fails","urgent":true}');
    const output = await run(
      harness,
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          triage,
          {
            kind: 'compute',
            id: 'label',
            expr: "$steps.triage.urgent ? 'now: ' & title : 'later'",
          },
        ],
      }),
    );
    expect(output).toBe('now: Login fails');
  });

  it('fails with model_parse_error on an answer that breaks the schema', async () => {
    const { harness } = modelHarness(() => '{"title":"Login fails"}');
    const error = await caught(run(harness, doc(triage)));
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'model_parse_error');
    expect(error.noeticError.stepId).toBe('triage');
  });

  it('fails with model_parse_error on an answer that is not JSON', async () => {
    const { harness } = modelHarness(() => 'no idea');
    const error = await caught(run(harness, doc(triage)));
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('model_parse_error');
  });

  it('refuses a schema that does not load when the document hydrates', () => {
    const { harness } = modelHarness(() => '');
    try {
      void run(
        harness,
        doc({
          ...triage,
          output: {
            schema: {
              type: 'object',
              properties: {
                title: {
                  $ref: '#/$defs/missing',
                },
              },
            },
          },
        }),
      );
      expect.unreachable('expected INVALID_OUTPUT_SCHEMA');
    } catch (error) {
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('INVALID_OUTPUT_SCHEMA');
      expect(error.message).toContain("'triage'");
    }
  });

  it('rejects an output that is neither a schema nor a codec reference', () => {
    const parsed = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        ...triage,
        output: {
          schema: 'object',
        },
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('callModel emit', () => {
  it('false keeps the step out of the stream', async () => {
    const { harness } = modelHarness(() => 'ok', 'host/default');
    const root = hydrateWorkflow(
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'callModel',
            id: 'loud',
            instructions: 'Answer.',
          },
          {
            kind: 'callModel',
            id: 'quiet',
            instructions: 'Answer.',
            emit: false,
          },
        ],
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const ctx = harness.createContext();
    const started: unknown[] = [];
    Reflect.set(ctx, '_broadcaster', {
      emit(event: { type: string; data: Record<string, unknown> }) {
        if (event.type.endsWith('step_started')) {
          started.push(event.data.stepId);
        }
      },
    });
    await harness.run(root, '', ctx);
    expect(started).toContain('loud');
    expect(started).not.toContain('quiet');
  });
});

describe('callModel default model', () => {
  const ask: WorkflowNode = {
    kind: 'callModel',
    id: 'ask',
    instructions: 'Answer.',
  };

  it('uses the harness model when the node names none', async () => {
    const { harness, requests } = modelHarness(() => 'ok', 'host/default');
    await run(harness, doc(ask));
    expect(requests[0]?.model).toBe('host/default');
  });

  it("uses the node's model over the harness model", async () => {
    const { harness, requests } = modelHarness(() => 'ok', 'host/default');
    await run(
      harness,
      doc({
        ...ask,
        model: 'node/own',
      }),
    );
    expect(requests[0]?.model).toBe('node/own');
  });

  it('runs on openai/gpt-4o when neither names one, as documents always have', async () => {
    const { harness, requests } = modelHarness(() => 'ok');
    await run(harness, doc(ask));
    expect(requests[0]?.model).toBe('openai/gpt-4o');
  });

  it('reads the harness model when the node runs, not when it hydrates', async () => {
    const requests: CallModelRequest[] = [];
    const root = hydrateWorkflow(doc(ask), {
      tools: new Map(),
      executeStep: execute,
    });
    for (const model of [
      'host/one',
      'host/two',
    ]) {
      const harness = new AgentHarness({
        name: 'host-documents',
        params: {},
        model,
        _testCallModel: async (request) => {
          requests.push(request);
          return makeLLMResponse('ok');
        },
      });
      await harness.run(root, '', harness.createContext());
    }
    expect(requests.map((request) => request.model)).toEqual([
      'host/one',
      'host/two',
    ]);
  });

  it('a TypeScript callModel with no model fails with MISSING_MODEL on a harness with none', async () => {
    const { harness, requests } = modelHarness(() => 'ok');
    const error = rootCause(
      await caught(
        harness.run(
          callModel({
            id: 'ask',
            instructions: 'Answer.',
          }),
          '',
          harness.createContext(),
        ),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('MISSING_MODEL');
    expect(requests).toHaveLength(0);
  });
});

describe('invokeTool args', () => {
  it('computes $expr values from the input and earlier outputs', async () => {
    const calls: unknown[] = [];
    const { harness } = modelHarness(() => '');
    await run(
      harness,
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'compute',
            id: 'order',
            expr: '{ "id": 7, "items": ["a", "b"] }',
          },
          {
            kind: 'compute',
            id: 'user',
            expr: '{ "name": "Ada" }',
          },
          {
            kind: 'invokeTool',
            id: 'send',
            toolName: 'echo',
            args: {
              to: {
                $expr: 'name',
              },
              order: {
                $expr: '$steps.order.id',
              },
              count: {
                $expr: '$count($steps.order.items)',
              },
              note: 'fixed',
              raw: {
                $literal: {
                  $expr: 'kept as data',
                },
              },
            },
          },
        ],
      }),
      {
        tools: [
          echoTool(calls),
        ],
      },
    );
    expect(calls).toEqual([
      {
        to: 'Ada',
        order: 7,
        count: 2,
        note: 'fixed',
        raw: {
          $expr: 'kept as data',
        },
      },
    ]);
  });

  it('computes every arg from one $expr', async () => {
    const calls: unknown[] = [];
    const { harness } = modelHarness(() => '');
    await run(
      harness,
      doc({
        kind: 'invokeTool',
        id: 'send',
        toolName: 'echo',
        args: {
          $expr: '{ "double": n * 2 }',
        },
      }),
      {
        input: '{"n":21}',
        tools: [
          echoTool(calls),
        ],
      },
    );
    expect(calls).toEqual([
      {
        double: 42,
      },
    ]);
  });

  it('passes other $-prefixed keys through as data', async () => {
    const calls: unknown[] = [];
    const { harness } = modelHarness(() => '');
    const args = {
      filter: {
        age: {
          $gt: 3,
        },
      },
      update: {
        $set: {
          seen: true,
        },
      },
    };
    await run(
      harness,
      doc({
        kind: 'invokeTool',
        id: 'send',
        toolName: 'echo',
        args,
      }),
      {
        tools: [
          echoTool(calls),
        ],
      },
    );
    expect(calls).toEqual([
      args,
    ]);
  });

  it("checks the computed args against the tool's input schema", async () => {
    const { harness } = modelHarness(() => '');
    const error = await caught(
      run(
        harness,
        doc({
          kind: 'invokeTool',
          id: 'give-up',
          toolName: 'fail',
          args: {
            node: {
              $expr: 'n',
            },
          },
        }),
        {
          input: '{"n":7}',
          tools: [
            failTool,
          ],
        },
      ),
    );
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'step_failed');
    expect(String(error.noeticError.cause)).toContain('Tool input validation failed');
  });

  it('asks the approver before a tool that needs approval, as the TypeScript step does', async () => {
    const calls: unknown[] = [];
    const asked: string[] = [];
    const harness = new AgentHarness({
      name: 'host-documents',
      params: {},
      approveToolCall: async ({ toolName }) => {
        asked.push(toolName);
        return {
          action: 'deny',
          guidance: 'not today',
        };
      },
    });
    const error = await caught(
      run(
        harness,
        doc({
          kind: 'invokeTool',
          id: 'send',
          toolName: 'echo',
          args: {
            to: 'Ada',
          },
        }),
        {
          tools: [
            {
              ...echoTool(calls),
              needsApproval: true,
            },
          ],
        },
      ),
    );
    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('steering_denied');
    expect(asked).toEqual([
      'echo',
    ]);
    expect(calls).toHaveLength(0);
  });

  it('reports an expression that does not parse', () => {
    const errors = expressionErrors({
      kind: 'invokeTool',
      id: 'send',
      toolName: 'echo',
      args: {
        to: {
          $expr: 'name &',
        },
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("args of invokeTool node 'send'");
  });
});

describe('$runs', () => {
  /** A loop that counts `n` down to zero, then reports how often its body ran. */
  function countdown(report: string): WorkflowNode {
    return {
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'loop',
          id: 'drain',
          body: {
            kind: 'compute',
            id: 'tick',
            expr: '{ "n": n - 1, "seen": $runs.drain }',
          },
          until: {
            kind: 'expr',
            expr: 'n = 0',
          },
        },
        {
          kind: 'compute',
          id: 'report',
          expr: report,
        },
      ],
    };
  }

  it('gives a later node how many times a loop ran', async () => {
    const { harness } = modelHarness(() => '');
    const output = await run(harness, doc(countdown('$runs.drain')), {
      input: '{"n":3}',
    });
    expect(output).toBe('3');
  });

  it('counts the runs so far inside the loop', async () => {
    const { harness } = modelHarness(() => '');
    const output = await run(harness, doc(countdown('seen')), {
      input: '{"n":3}',
    });
    expect(output).toBe('2');
  });

  it('lets an until expression stop on the count', async () => {
    const { harness } = modelHarness(() => '');
    const output = await run(
      harness,
      doc({
        kind: 'loop',
        id: 'tries',
        body: {
          kind: 'compute',
          id: 'try',
          expr: '{ "n": n + 1 }',
        },
        until: {
          kind: 'expr',
          expr: '$runs.tries = 4',
        },
      }),
      {
        input: '{"n":0}',
      },
    );
    expect(output).toBe('{"n":4}');
  });

  it('starts again each time the loop runs', async () => {
    const { harness } = modelHarness(() => '');
    const output = await run(
      harness,
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'loop',
            id: 'outer',
            body: {
              kind: 'sequence',
              id: 'pass',
              steps: [
                {
                  kind: 'loop',
                  id: 'inner',
                  body: {
                    kind: 'compute',
                    id: 'tick',
                    expr: '{ "left": left - 1 }',
                  },
                  until: {
                    kind: 'expr',
                    expr: '$runs.inner = 2',
                  },
                },
              ],
            },
            until: {
              kind: 'maxSteps',
              n: 3,
            },
          },
          {
            kind: 'compute',
            id: 'report',
            expr: '{ "outer": $runs.outer, "inner": $runs.inner }',
          },
        ],
      }),
      {
        input: '{"left":9}',
      },
    );
    expect(output).toBe('{"outer":3,"inner":2}');
  });

  it('keeps the count of a loop that replays on a resumed run', async () => {
    const storage = createInMemoryStorage();
    const flaky = {
      fail: true,
    };
    const tools: Tool[] = [
      {
        name: 'flaky',
        description: 'Fails once.',
        input: z.record(z.string(), z.unknown()),
        output: z.string(),
        execute: async () => {
          if (flaky.fail) {
            flaky.fail = false;
            throw new Error('host died');
          }
          return 'ok';
        },
      },
    ];
    const document = doc({
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'loop',
          id: 'drain',
          body: {
            kind: 'compute',
            id: 'tick',
            expr: '{ "n": n - 1 }',
          },
          until: {
            kind: 'expr',
            expr: 'n = 0',
          },
        },
        {
          kind: 'invokeTool',
          id: 'flaky',
          toolName: 'flaky',
        },
        {
          kind: 'compute',
          id: 'report',
          expr: '$runs.drain',
        },
      ],
    });
    const durable = (): AgentHarness =>
      new AgentHarness({
        name: 'host-documents',
        params: {},
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    const first = durable();
    const ctx = first.createContext();
    const root = hydrateWorkflow(document, {
      tools: new Map(
        tools.map((tool) => [
          tool.name,
          tool,
        ]),
      ),
      executeStep: execute,
    });
    await caught(first.run(root, '{"n":3}', ctx));

    const next = durable();
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(root, '{"n":3}', resumed)).toBe('3');
  });

  it('has no count for a loop that has not run', async () => {
    const { harness } = modelHarness(() => '');
    const output = await run(
      harness,
      doc({
        kind: 'compute',
        id: 'report',
        expr: '$exists($runs.drain)',
      }),
    );
    expect(output).toBe('false');
  });
});

describe('results keyed by branch', () => {
  it('builds them with a compute over $steps after the fork', async () => {
    const { harness } = modelHarness((request) => `answer from ${request.model}`);
    const output = await run(
      harness,
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'inParallel',
            id: 'fan',
            mode: 'all',
            paths: [
              {
                kind: 'callModel',
                id: 'fast',
                model: 'test/fast',
                instructions: 'Answer.',
              },
              {
                kind: 'callModel',
                id: 'careful',
                model: 'test/careful',
                instructions: 'Answer.',
              },
            ],
          },
          {
            kind: 'compute',
            id: 'keyed',
            expr: '{ "fast": $steps.fast, "careful": $steps.careful }',
          },
        ],
      }),
    );
    assert(typeof output === 'string');
    expect(JSON.parse(output)).toEqual({
      fast: 'answer from test/fast',
      careful: 'answer from test/careful',
    });
  });
});

describe('failing a flow from a node', () => {
  /** A loop that never succeeds, then a route that fails the flow once the tries are spent. */
  function givingUp(fail: WorkflowNode): WorkflowNode {
    return {
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'loop',
          id: 'tries',
          body: {
            kind: 'compute',
            id: 'try',
            expr: '{ "ok": false }',
          },
          until: {
            kind: 'any',
            predicates: [
              {
                kind: 'expr',
                expr: 'ok',
              },
              {
                kind: 'maxSteps',
                n: 3,
              },
            ],
          },
        },
        {
          kind: 'conditional',
          id: 'check',
          routes: [
            {
              expr: 'ok = false and $runs.tries = 3',
              target: fail,
            },
          ],
        },
      ],
    };
  }

  it("keeps a registered tool's error, under the step_failed of the node that threw", async () => {
    const { harness } = modelHarness(() => '');
    const error = await caught(
      run(
        harness,
        doc(
          givingUp({
            kind: 'invokeTool',
            id: 'give-up',
            toolName: 'fail',
            args: {
              node: 'tries',
            },
          }),
        ),
        {
          tools: [
            failTool,
          ],
        },
      ),
    );
    assert(isNoeticError(error));
    assert(error.noeticError.kind === 'step_failed');
    expect(error.noeticError.stepId).toBe('main');
    const thrower = error.noeticError.cause;
    assert(isNoeticError(thrower));
    assert(thrower.noeticError.kind === 'step_failed');
    expect(thrower.noeticError.stepId).toBe('give-up');
    const cause = thrower.noeticError.cause;
    assert(cause instanceof HostError);
    expect(cause.node).toBe('tries');
    expect(cause.message).toBe("Node 'tries' ran out of tries.");
  });

  it("keeps a connection operation's error", async () => {
    const harness = harnessWith(
      new FakeRegistry({
        flow: {
          ops: {
            'flow.fail': (args) => {
              throw new HostError(
                z
                  .object({
                    node: z.string(),
                  })
                  .parse(args).node,
              );
            },
          },
        },
      }),
    );
    const error = await caught(
      run(
        harness,
        doc(
          givingUp({
            kind: 'call',
            id: 'give-up',
            connection: 'flow',
            op: 'flow.fail',
            args: {
              node: 'tries',
            },
          }),
          {
            flow: {
              profile: 'flow@^1',
            },
          },
        ),
      ),
    );
    const cause = rootCause(error);
    assert(cause instanceof HostError);
    expect(cause.node).toBe('tries');
  });
});

describe('flow version', () => {
  const base: WorkflowNode = {
    kind: 'sequence',
    id: 'main',
    steps: [
      {
        kind: 'callModel',
        id: 'triage',
        instructions: 'Read the ticket.',
        output: {
          schema: TICKET_SCHEMA,
        },
      },
      {
        kind: 'invokeTool',
        id: 'send',
        toolName: 'echo',
        args: {
          to: {
            $expr: 'title',
          },
        },
      },
      {
        kind: 'acp-agent',
        id: 'fix',
        agent: 'coder',
        emit: false,
      },
    ],
  };

  function versionOf(root: WorkflowNode): string | undefined {
    return flowVersionOf(
      frameworkCast<Step>(
        hydrateWorkflow(doc(root), {
          tools: new Map([
            [
              'echo',
              echoTool([]),
            ],
          ]),
          executeStep: execute,
          acpAgents: new Map([
            [
              'coder',
              {
                specificationVersion: 'acp-v1',
                agentId: 'coder',
                async connect() {
                  throw new Error('never connected');
                },
              },
            ],
          ]),
        }),
      ),
    );
  }

  /** `base` with step `index` replaced. */
  function edited(index: number, node: WorkflowNode): WorkflowNode {
    assert(base.kind === 'sequence');
    return {
      ...base,
      steps: base.steps.map((entry, i) => (i === index ? node : entry)),
    };
  }

  it('changes when an output schema, an arg expression, or an agent node setting changes', () => {
    const version = versionOf(base);
    assert(version);
    expect(versionOf(base)).toBe(version);
    const edits: WorkflowNode[] = [
      edited(0, {
        kind: 'callModel',
        id: 'triage',
        instructions: 'Read the ticket.',
        output: {
          schema: {
            ...TICKET_SCHEMA,
            required: [
              'title',
            ],
          },
        },
      }),
      edited(1, {
        kind: 'invokeTool',
        id: 'send',
        toolName: 'echo',
        args: {
          to: {
            $expr: '$uppercase(title)',
          },
        },
      }),
      edited(2, {
        kind: 'acp-agent',
        id: 'fix',
        agent: 'coder',
        emit: true,
      }),
      edited(2, {
        kind: 'acp-agent',
        id: 'fix',
        agent: 'coder',
        prompt: 'Fix it.',
        emit: false,
      }),
    ];
    const versions = edits.map(versionOf);
    expect(
      new Set([
        version,
        ...versions,
      ]).size,
    ).toBe(edits.length + 1);
  });
});
