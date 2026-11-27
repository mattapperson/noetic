// A JSON workflow node's options read from the harness params (spec 26
// § Options from params): the JSON form of every function a TypeScript step
// takes. Each param is read, and a function called, every time its option is.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  CallModelRequest,
  DecideRequest,
  DecideResponse,
  Tool,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { channel } from '../../src/builders/channel-builder';
import { dynamicWorkflow, parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { documentConnectionUses } from '../../src/builders/workflow-connections';
import { hydrateWorkflow } from '../../src/builders/workflow-source';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import { lookupStep } from '../../src/runtime/step-registry';
import { WorkflowDocumentSchema } from '../../src/schemas/workflow';
import { setHarnessInternals } from '../../src/util/harness-internals';
import { makeLLMResponse } from '../_helpers';
import { FakeRegistry } from '../steps-connections/_helpers';

//#region Helpers

function doc(root: WorkflowNode): WorkflowDocument {
  return {
    version: 1,
    root,
  };
}

interface Rig {
  harness: AgentHarness;
  requests: CallModelRequest[];
  decides: DecideRequest[];
}

/** A harness with `params`, whose model answers `answer` and whose decider answers `team: auth`. */
function rig(params: Record<string, unknown>, answer = 'ok'): Rig {
  const requests: CallModelRequest[] = [];
  const decides: DecideRequest[] = [];
  const harness = new AgentHarness({
    name: 'from-params',
    params,
    model: 'host/default',
    decisionModel: 'host/decider',
    _testCallModel: async (request) => {
      requests.push(request);
      return makeLLMResponse(answer);
    },
    _testDecide: async (request): Promise<DecideResponse> => {
      decides.push(request);
      return {
        answers: {
          team: {
            type: 'choice',
            value: 'auth',
            confidence: 0.9,
            probabilities: {
              auth: 0.9,
              billing: 0.1,
            },
          },
        },
        source: 'native',
        modelId: request.model,
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      };
    },
  });
  return {
    harness,
    requests,
    decides,
  };
}

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

function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

const TEAM = {
  team: {
    type: 'choice',
    instructions: 'Which team?',
    choices: {
      auth: 'Sign-in',
      billing: 'Refunds',
    },
  },
} as const;

//#endregion

describe('reading a param', () => {
  it('calls the function every time the option is read, and sees a swapped param', async () => {
    let calls = 0;
    const params: Record<string, unknown> = {
      pickModel: () => `model-${++calls}`,
    };
    const { harness, requests } = rig(params);
    const document = doc({
      kind: 'loop',
      id: 'twice',
      body: {
        kind: 'callModel',
        id: 'ask',
        instructions: 'Answer.',
        fromParams: {
          model: 'pickModel',
        },
      },
      until: {
        kind: 'maxSteps',
        n: 2,
      },
    });
    await run(harness, document);
    params.pickModel = 'fixed-model';
    await run(harness, document);
    expect(requests.map((request) => request.model)).toEqual([
      'model-1',
      'model-2',
      'fixed-model',
      'fixed-model',
    ]);
  });

  it('fails the run at its start when the harness has no such param', async () => {
    const ran: string[] = [];
    const { harness } = rig({
      note: () => {
        ran.push('note');
        return 'x';
      },
    });
    const error = await caught(
      run(
        harness,
        doc({
          kind: 'sequence',
          id: 'main',
          steps: [
            {
              kind: 'runCode',
              id: 'first',
              fromParams: {
                execute: 'note',
              },
            },
            {
              kind: 'callModel',
              id: 'ask',
              fromParams: {
                model: 'missing',
              },
            },
          ],
        }),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('UNKNOWN_PARAM_REFERENCE');
    expect(error.message).toContain("'model' of workflow node 'ask'");
    expect(ran).toEqual([]);
  });

  it('refuses an option set on the node and read from a param', () => {
    const parsed = WorkflowDocumentSchema.safeParse(
      doc({
        kind: 'callModel',
        id: 'ask',
        model: 'a/b',
        fromParams: {
          model: 'pickModel',
        },
      }),
    );
    assert(!parsed.success);
    expect(parsed.error.message).toContain('give one');
  });

  it('refuses an option the node kind does not have', () => {
    const parsed = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'compute',
        id: 'c',
        expr: '1',
        fromParams: {
          model: 'pickModel',
        },
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('a document the host did not write', () => {
  const document = doc({
    kind: 'callModel',
    id: 'ask',
    fromParams: {
      instructions: 'secretPrompt',
    },
  });

  it('may read no param the host did not grant', async () => {
    const { harness, requests } = rig({
      secretPrompt: 'the key is 123',
    });
    const error = await caught(
      parseAndRunWorkflow({
        json: document,
        harness,
        ctx: harness.createContext(),
        tools: [],
        input: '',
      }),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('PARAM_NOT_ALLOWED');
    expect(requests).toHaveLength(0);
  });

  it('reads a granted param', async () => {
    const { harness, requests } = rig({
      secretPrompt: 'Be brief.',
    });
    await parseAndRunWorkflow({
      json: document,
      harness,
      ctx: harness.createContext(),
      tools: [],
      input: '',
      params: [
        'secretPrompt',
      ],
    });
    expect(requests[0]?.instructions).toBe('Be brief.');
  });

  it('is refused before it runs when a granted param is missing', async () => {
    const { harness } = rig({});
    const error = await caught(
      parseAndRunWorkflow({
        json: document,
        harness,
        ctx: harness.createContext(),
        tools: [],
        input: '',
        params: [
          'secretPrompt',
        ],
      }),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('UNKNOWN_PARAM_REFERENCE');
  });
});

describe('callModel', () => {
  it('reads model, instructions and tools from params, each given the context', async () => {
    const seen: string[] = [];
    const lookup: Tool = {
      name: 'lookup',
      description: 'Looks up.',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'found',
    };
    const { harness, requests } = rig({
      pickModel: (ctx: {
        harness: {
          config: {
            name: string;
          };
        };
      }) => {
        seen.push(ctx.harness.config.name);
        return 'picked/model';
      },
      prompt: () => 'Be brief.',
      pickTools: () => [
        lookup,
      ],
    });
    await run(
      harness,
      doc({
        kind: 'callModel',
        id: 'ask',
        fromParams: {
          model: 'pickModel',
          instructions: 'prompt',
          tools: 'pickTools',
        },
      }),
    );
    expect(seen).toEqual([
      'from-params',
    ]);
    expect(requests[0]?.model).toBe('picked/model');
    expect(requests[0]?.instructions).toBe('Be brief.');
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      'lookup',
    ]);
  });

  it('filters its framework events with a param, given the event and the context', async () => {
    const asked: string[] = [];
    const { harness } = rig({
      quiet: (eventType: string) => {
        asked.push(eventType);
        return false;
      },
    });
    const root = hydrateWorkflow(
      doc({
        kind: 'callModel',
        id: 'ask',
        instructions: 'Answer.',
        fromParams: {
          emit: 'quiet',
        },
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
    expect(asked).toContain('step_started');
    expect(started).toEqual([]);
  });

  it('takes a projection', async () => {
    const root = hydrateWorkflow(
      doc({
        kind: 'callModel',
        id: 'ask',
        instructions: 'Answer.',
        projection: {
          tokenBudget: 1e3,
          responseReserve: 100,
          overflow: 'truncate',
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    assert(root.kind === 'callModel');
    expect(root.projection?.tokenBudget).toBe(1e3);
  });
});

describe('runCode', () => {
  it('runs a function from the params in process, given the input and the context', async () => {
    const { harness } = rig({
      shout: (
        input: string,
        ctx: {
          harness: {
            config: {
              name: string;
            };
          };
        },
      ) => `${input.toUpperCase()} from ${ctx.harness.config.name}`,
    });
    const output = await run(
      harness,
      doc({
        kind: 'runCode',
        id: 'shout',
        fromParams: {
          execute: 'shout',
        },
      }),
      {
        input: 'hi',
      },
    );
    expect(output).toBe('HI from from-params');
  });

  it('needs code or a function', () => {
    const parsed = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'runCode',
        id: 'nothing',
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('invokeTool', () => {
  it('reads its args from a param', async () => {
    const calls: unknown[] = [];
    const { harness } = rig({
      argsFor: (input: string) => ({
        to: input,
      }),
    });
    await run(
      harness,
      doc({
        kind: 'invokeTool',
        id: 'send',
        toolName: 'echo',
        fromParams: {
          args: 'argsFor',
        },
      }),
      {
        input: 'Ada',
        tools: [
          {
            name: 'echo',
            description: 'Echoes.',
            input: z.record(z.string(), z.unknown()),
            output: z.unknown(),
            execute: async (args: unknown) => {
              calls.push(args);
              return args;
            },
          },
        ],
      },
    );
    expect(calls).toEqual([
      {
        to: 'Ada',
      },
    ]);
  });
});

describe('decide and routeSwitch', () => {
  it('reads model, instructions and context from params', async () => {
    const { harness, decides } = rig({
      pickModel: () => 'picked/decider',
      prompt: 'Decide well.',
      extra: () => ({
        tier: 'gold',
      }),
    });
    await run(
      harness,
      doc({
        kind: 'decide',
        id: 'route',
        questions: TEAM,
        fromParams: {
          model: 'pickModel',
          instructions: 'prompt',
          context: 'extra',
        },
      }),
      {
        input: 'help',
      },
    );
    expect(decides[0]?.model).toBe('picked/decider');
    expect(decides[0]?.instructions).toBe('Decide well.');
    expect(JSON.stringify(decides[0]?.state)).toContain('gold');
  });

  it('routes by a function of the answers, with a default', async () => {
    const node = (pick: string): WorkflowNode => ({
      kind: 'routeSwitch',
      id: 'switch',
      decide: {
        kind: 'decide',
        id: 'route',
        questions: TEAM,
      },
      fromParams: {
        on: pick,
      },
      cases: {
        vip: {
          kind: 'compute',
          id: 'vip',
          expr: "'vip desk'",
        },
      },
      default: {
        kind: 'compute',
        id: 'other',
        expr: "'front desk'",
      },
    });
    const { harness } = rig({
      toVip: (answers: {
        team: {
          value: string;
        };
      }) => (answers.team.value === 'auth' ? 'vip' : 'x'),
      toNowhere: () => 'nowhere',
    });
    expect(await run(harness, doc(node('toVip')))).toBe('vip desk');
    expect(await run(harness, doc(node('toNowhere')))).toBe('front desk');
  });

  it('a routeSwitch routed by a function needs a default', () => {
    const parsed = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'routeSwitch',
        id: 'switch',
        decide: {
          kind: 'decide',
          id: 'route',
          questions: TEAM,
        },
        fromParams: {
          on: 'pick',
        },
        cases: {},
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('conditional', () => {
  const node: WorkflowNode = {
    kind: 'conditional',
    id: 'pick',
    fromParams: {
      route: 'pickRoute',
    },
    routes: [
      {
        target: {
          kind: 'compute',
          id: 'small',
          expr: "'small'",
        },
      },
      {
        target: {
          kind: 'compute',
          id: 'big',
          expr: "'big'",
        },
      },
    ],
    default: {
      kind: 'compute',
      id: 'none',
      expr: "'none'",
    },
  };

  it('takes the target whose id the function gives, or the default for nothing', async () => {
    const { harness } = rig({
      pickRoute: (input: string) =>
        input === '' ? undefined : Number(input) > 10 ? 'big' : 'small',
    });
    expect(
      await run(harness, doc(node), {
        input: '3',
      }),
    ).toBe('small');
    expect(
      await run(harness, doc(node), {
        input: '30',
      }),
    ).toBe('big');
    expect(await run(harness, doc(node))).toBe('none');
  });

  it('fails with UNKNOWN_ROUTE_TARGET for an id none of its targets has', async () => {
    const { harness } = rig({
      pickRoute: () => 'elsewhere',
    });
    const error = rootCause(await caught(run(harness, doc(node))));
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('UNKNOWN_ROUTE_TARGET');
  });

  it('gives its routes no test when a function routes', () => {
    const parsed = WorkflowDocumentSchema.safeParse(
      doc({
        ...node,
        routes: [
          {
            match: 'x',
            target: {
              kind: 'compute',
              id: 'small',
              expr: "'small'",
            },
          },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('inParallel', () => {
  const paths: WorkflowNode[] = [
    {
      kind: 'compute',
      id: 'a',
      expr: "'A'",
    },
    {
      kind: 'compute',
      id: 'b',
      expr: "'B'",
    },
  ];

  it('merges with a function of the results', async () => {
    const { harness } = rig({
      join: (results: string[]) => results.join('+'),
    });
    expect(
      await run(
        harness,
        doc({
          kind: 'inParallel',
          id: 'fan',
          mode: 'all',
          paths,
          fromParams: {
            merge: 'join',
          },
        }),
      ),
    ).toBe('A+B');
  });

  it('gives a settle merge the settled results, failures included', async () => {
    const { harness } = rig({
      tally: (
        results: Array<{
          status: string;
        }>,
      ) => results.map((r) => r.status).join(','),
      boom: () => {
        throw new Error('boom');
      },
    });
    expect(
      await run(
        harness,
        doc({
          kind: 'inParallel',
          id: 'fan',
          mode: 'settle',
          paths: [
            paths[0] ?? expect.unreachable(),
            {
              kind: 'runCode',
              id: 'bad',
              fromParams: {
                execute: 'boom',
              },
            },
          ],
          fromParams: {
            merge: 'tally',
          },
        }),
      ),
    ).toBe('fulfilled,rejected');
  });
});

describe('loop', () => {
  it('stops on an Until function from the params', async () => {
    const { harness } = rig({
      enough: (snapshot: { stepCount: number }) => ({
        stop: snapshot.stepCount === 3,
      }),
    });
    expect(
      await run(
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
            kind: 'param',
            name: 'enough',
          },
        }),
        {
          input: '{"n":0}',
        },
      ),
    ).toBe('{"n":3}');
  });

  it('shapes the next input with prepareNext', async () => {
    const { harness } = rig({
      next: (output: string) =>
        JSON.stringify({
          n: JSON.parse(output).n * 10,
        }),
    });
    expect(
      await run(
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
            kind: 'maxSteps',
            n: 2,
          },
          fromParams: {
            prepareNext: 'next',
          },
        }),
        {
          input: '{"n":0}',
        },
      ),
    ).toBe('{"n":11}');
  });

  it('retries a failed body when onError says so, fixed or from a param', async () => {
    for (const onError of [
      {
        onError: 'retry' as const,
      },
      {
        fromParams: {
          onError: 'again',
        },
      },
    ]) {
      let fails = 2;
      const { harness } = rig({
        again: () => 'retry',
        flaky: () => {
          if (fails-- > 0) {
            throw new Error('not yet');
          }
          return 'done';
        },
      });
      expect(
        await run(
          harness,
          doc({
            kind: 'loop',
            id: 'tries',
            body: {
              kind: 'runCode',
              id: 'try',
              fromParams: {
                execute: 'flaky',
              },
            },
            until: {
              kind: 'maxSteps',
              n: 1,
            },
            ...onError,
          }),
        ),
      ).toBe('done');
    }
  });

  it('takes maxHistorySize, parkTimeout and an inbox channel', () => {
    const root = hydrateWorkflow(
      doc({
        kind: 'loop',
        id: 'tries',
        body: {
          kind: 'compute',
          id: 'try',
          expr: '$',
        },
        until: {
          kind: 'maxSteps',
          n: 1,
        },
        maxHistorySize: 5,
        parkTimeout: 250,
        inbox: {
          name: 'notes',
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    assert(root.kind === 'loop');
    expect(root.maxHistorySize).toBe(5);
    expect(root.parkTimeout).toBe(250);
    expect(root.inbox?.name).toBe('notes');
    expect(root.inbox?.mode).toBe('queue');
  });
});

describe('every node', () => {
  it('keys replay on a function of the input', () => {
    const root = hydrateWorkflow(
      doc({
        kind: 'compute',
        id: 'c',
        expr: '$',
        fromParams: {
          replayKey: 'keyOf',
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const { harness } = rig({
      keyOf: (input: string) => `k-${input}`,
    });
    expect(root.replayKey?.('7', harness.createContext())).toBe('k-7');
  });

  it('emits what a function of the output gives', async () => {
    const { harness } = rig({
      note: (output: string) => `note: ${output}`,
    });
    const root = hydrateWorkflow(
      doc({
        kind: 'compute',
        id: 'c',
        expr: "'done'",
        fromParams: {
          emitItems: 'note',
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const ctx = harness.createContext();
    await harness.run(root, '', ctx);
    expect(JSON.stringify(ctx.itemLog.items)).toContain('note: done');
  });
});

describe('checks before a run', () => {
  const READS_MISSING: WorkflowNode = {
    kind: 'sequence',
    id: 'main',
    steps: [
      {
        kind: 'runCode',
        id: 'first',
        fromParams: {
          execute: 'note',
        },
      },
      {
        kind: 'callModel',
        id: 'ask',
        fromParams: {
          model: 'missing',
        },
      },
    ],
  };

  it('refuses an execute() turn whose flow reads a param the harness lacks, before any node runs', async () => {
    const ran: string[] = [];
    const harness = new AgentHarness({
      name: 'from-params',
      params: {
        note: () => {
          ran.push('note');
          return 'x';
        },
      },
      agentGraph: hydrateWorkflow(doc(READS_MISSING), {
        tools: new Map(),
        executeStep: execute,
      }),
      _testCallModel: async () => makeLLMResponse('ok'),
    });
    const error = await caught(harness.execute('hello'));
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('UNKNOWN_PARAM_REFERENCE');
    expect(ran).toEqual([]);
  });

  it('checks the named workflows a document reaches, and no others', async () => {
    const reads = (param: string): WorkflowDocument =>
      doc({
        kind: 'runCode',
        id: 'inner',
        fromParams: {
          execute: param,
        },
      });
    const hydrated = (ref: string) =>
      hydrateWorkflow(
        doc({
          kind: 'subflow',
          id: 'sub',
          ref,
        }),
        {
          tools: new Map(),
          executeStep: execute,
          workflows: new Map([
            [
              'has',
              reads('here'),
            ],
            [
              'lacks',
              reads('notHere'),
            ],
          ]),
        },
      );
    const { harness } = rig({
      here: () => 'ran',
    });
    expect(await harness.run(hydrated('has'), '', harness.createContext())).toBe('ran');
    const error = await caught(harness.run(hydrated('lacks'), '', harness.createContext()));
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('UNKNOWN_PARAM_REFERENCE');
  });

  it('refuses a param the host did not grant wherever the document names it', async () => {
    const nested: WorkflowNode[] = [
      {
        kind: 'loop',
        id: 'l',
        body: {
          kind: 'compute',
          id: 'c',
          expr: '$',
        },
        until: {
          kind: 'any',
          predicates: [
            {
              kind: 'param',
              name: 'secret',
            },
            {
              kind: 'maxSteps',
              n: 1,
            },
          ],
        },
      },
      {
        kind: 'routeSwitch',
        id: 'r',
        decide: {
          kind: 'decide',
          id: 'd',
          questions: TEAM,
          fromParams: {
            instructions: 'secret',
          },
        },
        on: 'team',
        cases: {
          auth: {
            kind: 'compute',
            id: 'a',
            expr: '$',
          },
          billing: {
            kind: 'compute',
            id: 'b',
            expr: '$',
          },
        },
        uncertain: {
          kind: 'compute',
          id: 'u',
          expr: '$',
        },
      },
      {
        kind: 'subflow',
        id: 's',
        document: {
          version: 1,
          root: {
            kind: 'compute',
            id: 'c',
            expr: '$',
            fromParams: {
              emitItems: 'secret',
            },
          },
        },
      },
    ];
    for (const root of nested) {
      const { harness } = rig({
        secret: () => 'x',
      });
      const error = await caught(
        parseAndRunWorkflow({
          json: doc(root),
          harness,
          ctx: harness.createContext(),
          tools: [],
          input: '',
        }),
      );
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('PARAM_NOT_ALLOWED');
    }
  });

  it('never lets a document the host did not write read from a param what its grants cannot check', async () => {
    const { harness } = rig({
      pickTools: () => [],
    });
    const error = await caught(
      parseAndRunWorkflow({
        json: doc({
          kind: 'callModel',
          id: 'ask',
          fromParams: {
            tools: 'pickTools',
          },
        }),
        harness,
        ctx: harness.createContext(),
        tools: [],
        input: '',
        params: [
          'pickTools',
        ],
      }),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('PARAM_NOT_ALLOWED');
    expect(error.message).toContain("'tools' of workflow node 'ask'");
  });
});

describe('a function that must not give a promise', () => {
  const tries = (fromParams: { prepareNext?: string; onError?: string }): WorkflowNode => ({
    kind: 'loop',
    id: 'tries',
    body: {
      kind: 'runCode',
      id: 'try',
      fromParams: {
        execute: 'flaky',
      },
    },
    until: {
      kind: 'maxSteps',
      n: 2,
    },
    fromParams,
  });

  it('fails with PARAM_MUST_BE_SYNC for prepareNext and onError', async () => {
    for (const fromParams of [
      {
        prepareNext: 'later',
      },
      {
        onError: 'later',
      },
    ]) {
      const { harness } = rig({
        later: async () => 'retry',
        flaky: () => {
          if ('onError' in fromParams) {
            throw new Error('fails');
          }
          return 'ok';
        },
      });
      const error = rootCause(await caught(run(harness, doc(tries(fromParams)))));
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('PARAM_MUST_BE_SYNC');
    }
  });

  it('fails with PARAM_MUST_BE_SYNC for a replayKey', () => {
    const root = hydrateWorkflow(
      doc({
        kind: 'compute',
        id: 'c',
        expr: '$',
        fromParams: {
          replayKey: 'later',
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const { harness } = rig({
      later: async () => 'k',
    });
    try {
      root.replayKey?.('7', harness.createContext());
      expect.unreachable('expected PARAM_MUST_BE_SYNC');
    } catch (error) {
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('PARAM_MUST_BE_SYNC');
    }
  });
});

describe('emitItems from params', () => {
  const PROGRESS = {
    progress: {
      type: 'app:progress',
      event: {
        type: 'object',
        properties: {
          pct: {
            type: 'number',
          },
        },
        required: [
          'pct',
        ],
      },
      output: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
          },
        },
        required: [
          'note',
        ],
      },
    },
  };

  /** Runs `root` and returns its output with the custom item events and items it gave. */
  async function emitted(
    params: Record<string, unknown>,
    root: WorkflowNode,
  ): Promise<{
    output: unknown;
    events: unknown[];
    items: string;
  }> {
    const { harness } = rig(params);
    const step = hydrateWorkflow(
      {
        version: 1,
        customItems: PROGRESS,
        root,
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const ctx = harness.createContext();
    const events: unknown[] = [];
    Reflect.set(ctx, '_broadcaster', {
      emit(event: { type: string; data: Record<string, unknown> }) {
        if (event.type.endsWith('custom_item_event')) {
          events.push(event.data.event);
        }
      },
    });
    const output = await harness.run(step, 'in', ctx);
    return {
      output,
      events,
      items: JSON.stringify(ctx.itemLog.items),
    };
  }

  it('streams the events a generator execute yields, and returns what it returns', async () => {
    const { output, events, items } = await emitted(
      {
        work: async function* () {
          yield {
            pct: 50,
          };
          return 'finished';
        },
      },
      {
        kind: 'runCode',
        id: 'work',
        fromParams: {
          execute: 'work',
        },
        emitItems: {
          item: 'progress',
          onDone: '{ "note": $ }',
        },
      },
    );
    expect(output).toBe('finished');
    expect(events).toEqual([
      {
        pct: 50,
      },
    ]);
    expect(items).toContain('"note":"finished"');
  });

  it('runs onStart and onDone hooks from params, given the value and the context', async () => {
    const { events, items } = await emitted(
      {
        begin: async function* (input: string) {
          yield {
            pct: input.length,
          };
          return undefined;
        },
        finish: (output: string) => ({
          note: `done ${output}`,
        }),
      },
      {
        kind: 'compute',
        id: 'c',
        expr: "'out'",
        emitItems: {
          item: 'progress',
        },
        fromParams: {
          onStart: 'begin',
          onDone: 'finish',
        },
      },
    );
    expect(events).toEqual([
      {
        pct: 2,
      },
    ]);
    expect(items).toContain('"note":"done out"');
  });

  it('fails with PARAM_NOT_A_FUNCTION when the emitItems param is not a function', async () => {
    const { harness } = rig({
      note: true,
    });
    const error = rootCause(
      await caught(
        run(
          harness,
          doc({
            kind: 'compute',
            id: 'c',
            expr: "'out'",
            fromParams: {
              emitItems: 'note',
            },
          }),
        ),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('PARAM_NOT_A_FUNCTION');
  });

  it('gives a hook expression $steps', async () => {
    const { harness } = rig({});
    const root = hydrateWorkflow(
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'compute',
            id: 'first',
            expr: "'one'",
          },
          {
            kind: 'compute',
            id: 'second',
            expr: "'two'",
            emitItems: {
              onDone: "$steps.first & ' then ' & $",
            },
          },
        ],
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const ctx = harness.createContext();
    await harness.run(root, '', ctx);
    expect(JSON.stringify(ctx.itemLog.items)).toContain('one then two');
  });
});

describe('schema checks', () => {
  it('refuses an option set twice on a decide node inside a routeSwitch or an until', () => {
    const decide = {
      kind: 'decide',
      id: 'd',
      model: 'a/b',
      questions: {
        done: {
          type: 'boolean',
          instructions: 'Done?',
        },
      },
      fromParams: {
        model: 'pickModel',
      },
    };
    const inSwitch = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'routeSwitch',
        id: 'r',
        decide,
        on: 'done',
        cases: {
          true: {
            kind: 'compute',
            id: 't',
            expr: '$',
          },
          false: {
            kind: 'compute',
            id: 'f',
            expr: '$',
          },
        },
        uncertain: {
          kind: 'compute',
          id: 'u',
          expr: '$',
        },
      },
    });
    const inUntil = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'loop',
        id: 'l',
        body: {
          kind: 'compute',
          id: 'c',
          expr: '$',
        },
        until: decide,
      },
    });
    expect(inSwitch.success).toBe(false);
    expect(inUntil.success).toBe(false);
  });

  it('refuses a merge on a race, and a hook given twice', () => {
    const race = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'inParallel',
        id: 'fan',
        mode: 'race',
        paths: [
          {
            kind: 'compute',
            id: 'a',
            expr: '$',
          },
        ],
        fromParams: {
          merge: 'join',
        },
      },
    });
    const hook = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'compute',
        id: 'c',
        expr: '$',
        emitItems: {
          onDone: '$',
        },
        fromParams: {
          onDone: 'finish',
        },
      },
    });
    expect(race.success).toBe(false);
    expect(hook.success).toBe(false);
  });
});

describe('routeSwitch by a function', () => {
  it('takes uncertain when the decision is refused', async () => {
    const harness = new AgentHarness({
      name: 'from-params',
      params: {
        pick: () => 'vip',
      },
      decisionModel: 'host/decider',
      _testDecide: async (request): Promise<DecideResponse> => ({
        answers: {
          team: {
            type: 'refusal',
          },
        },
        source: 'native',
        modelId: request.model,
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      }),
    });
    expect(
      await run(
        harness,
        doc({
          kind: 'routeSwitch',
          id: 'switch',
          decide: {
            kind: 'decide',
            id: 'route',
            questions: TEAM,
          },
          fromParams: {
            on: 'pick',
          },
          cases: {
            vip: {
              kind: 'compute',
              id: 'vip',
              expr: "'vip desk'",
            },
          },
          default: {
            kind: 'compute',
            id: 'other',
            expr: "'front desk'",
          },
          uncertain: {
            kind: 'compute',
            id: 'unsure',
            expr: "'ask a person'",
          },
        }),
      ),
    ).toBe('ask a person');
  });
});

describe('decide', () => {
  it('takes a projection, and emit as a boolean or a filter from a param', async () => {
    const asked: string[] = [];
    const { harness } = rig({
      quiet: (eventType: string) => {
        asked.push(eventType);
        return false;
      },
    });
    for (const emit of [
      {
        emit: false,
      },
      {
        fromParams: {
          emit: 'quiet',
        },
      },
    ]) {
      const root = hydrateWorkflow(
        doc({
          kind: 'decide',
          id: 'route',
          questions: TEAM,
          projection: {
            tokenBudget: 2e3,
            responseReserve: 100,
            overflow: 'truncate',
          },
          ...emit,
        }),
        {
          tools: new Map(),
          executeStep: execute,
        },
      );
      assert(root.kind === 'decide');
      expect(root.projection?.tokenBudget).toBe(2e3);
      const ctx = harness.createContext();
      const started: unknown[] = [];
      Reflect.set(ctx, '_broadcaster', {
        emit(event: { type: string; data: Record<string, unknown> }) {
          if (event.type.endsWith('step_started')) {
            started.push(event.data.stepId);
          }
        },
      });
      await harness.run(root, 'help', ctx);
      expect(started).toEqual([]);
    }
    expect(asked).toContain('step_started');
  });
});

describe('loop inbox', () => {
  it('runs again on a message in its inbox, read as a queue by name', async () => {
    let sent = false;
    let runs = 0;
    const notes = channel('notes', {
      schema: z.string(),
      mode: 'queue',
    });
    const { harness } = rig({
      work: async (
        _input: string,
        ctx: {
          send(ch: typeof notes, value: string): void;
        },
      ) => {
        runs += 1;
        if (!sent) {
          sent = true;
          ctx.send(notes, 'one more');
        }
        return `run ${runs}`;
      },
    });
    expect(
      await run(
        harness,
        doc({
          kind: 'loop',
          id: 'tries',
          body: {
            kind: 'runCode',
            id: 'work',
            fromParams: {
              execute: 'work',
            },
          },
          until: {
            kind: 'maxSteps',
            n: 1,
          },
          inbox: {
            name: 'notes',
          },
          maxHistorySize: 1,
        }),
      ),
    ).toBe('run 2');
  });
});

describe('replayKey', () => {
  it('replays a node by the key its function gives on a resumed run', async () => {
    const storage = createInMemoryStorage();
    const ran: string[] = [];
    let fail = true;
    const params = {
      keyOf: (input: string) => `k-${input}`,
      head: (input: string) => {
        ran.push('head');
        return `${input}h`;
      },
      tail: (input: string) => {
        ran.push('tail');
        if (fail) {
          fail = false;
          throw new Error('host died');
        }
        return `${input}t`;
      },
    };
    const durable = (): AgentHarness =>
      new AgentHarness({
        name: 'from-params',
        params,
        environment: {
          storage: {
            adapter: storage,
          },
        },
      });
    const root = hydrateWorkflow(
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'runCode',
            id: 'head',
            fromParams: {
              execute: 'head',
              replayKey: 'keyOf',
            },
          },
          {
            kind: 'runCode',
            id: 'tail',
            fromParams: {
              execute: 'tail',
            },
          },
        ],
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const first = durable();
    const ctx = first.createContext();
    await caught(first.run(root, 'x', ctx));
    const next = durable();
    const resumed = await next.restore(ctx.id);
    assert(resumed);
    expect(await next.run(root, 'x', resumed)).toBe('xht');
    expect(ran).toEqual([
      'head',
      'tail',
      'tail',
    ]);
  });
});

describe('connection nodes', () => {
  const MANIFEST = {
    team: {
      profile: 'chat@^1',
    },
    ops: {
      profile: 'chat@^1',
    },
  };

  function connected(params: Record<string, unknown>, registry: FakeRegistry): AgentHarness {
    const harness = new AgentHarness({
      name: 'from-params',
      params,
    });
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
    return harness;
  }

  it('call reads its args and its connection from params', async () => {
    const registry = new FakeRegistry({
      team: {
        ops: {
          'chat.post': (args) => args,
        },
      },
      ops: {
        ops: {
          'chat.post': () => 'wrong connection',
        },
      },
    });
    const harness = connected(
      {
        argsFor: (input: string) => ({
          text: `re: ${input}`,
        }),
        pickConnection: () => 'team',
      },
      registry,
    );
    const root = hydrateWorkflow(
      {
        version: 1,
        connections: MANIFEST,
        root: {
          kind: 'call',
          id: 'post',
          op: 'chat.post',
          fromParams: {
            args: 'argsFor',
            connection: 'pickConnection',
          },
        },
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    expect(JSON.stringify(await harness.run(root, 'hello', harness.createContext()))).toBe(
      '{"text":"re: hello"}',
    );
    expect(registry.calls.map((call) => call.connection)).toEqual([
      'team',
    ]);
  });

  it('refuses a connection name the manifest does not declare', async () => {
    const harness = connected(
      {
        pickConnection: () => 'elsewhere',
      },
      new FakeRegistry({}),
    );
    const root = hydrateWorkflow(
      {
        version: 1,
        connections: MANIFEST,
        root: {
          kind: 'call',
          id: 'post',
          op: 'chat.post',
          fromParams: {
            connection: 'pickConnection',
          },
        },
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const error = rootCause(await caught(harness.run(root, '', harness.createContext())));
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('CONNECTION_UNKNOWN');
  });

  it('wait takes the event its filter function says is the one', async () => {
    const registry: FakeRegistry = new FakeRegistry({
      team: {
        ops: {
          'chat.reply': () => {
            registry.emit('team', 'chat.message.created', {
              text: 'no',
            });
            registry.emit('team', 'chat.message.created', {
              text: 'approve',
            });
            return {
              posted: true,
            };
          },
        },
      },
    });
    const harness = connected(
      {
        approves: (event: {
          payload: {
            text: string;
          };
        }) => event.payload.text === 'approve',
      },
      registry,
    );
    const root = hydrateWorkflow(
      {
        version: 1,
        connections: {
          team: MANIFEST.team,
        },
        root: {
          kind: 'wait',
          id: 'approval',
          connection: 'team',
          event: 'chat.message.created',
          around: [
            {
              'chat.reply': {
                text: 'Approve?',
              },
            },
          ],
          timeoutMs: 1e3,
          fromParams: {
            filter: 'approves',
          },
        },
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const output = await harness.run(root, '', harness.createContext());
    expect(JSON.stringify(output)).toContain('approve');
  });

  it('verify takes its subject from a param, checked against the manifest', async () => {
    const { harness } = rig({
      pickSubject: () => 'team',
      pickWrong: () => 'elsewhere',
    });
    const subjectOf = (param: string) => {
      const root = hydrateWorkflow(
        {
          version: 1,
          connections: MANIFEST,
          root: {
            kind: 'verify',
            id: 'check',
            expect: [
              {
                ui: 'button "Save"',
              },
            ],
            act: {
              'ui.tap': {
                element: 'button "Save"',
              },
            },
            fromParams: {
              subject: param,
            },
          },
        },
        {
          tools: new Map(),
          executeStep: execute,
        },
      );
      assert(root.kind === 'verify');
      assert(typeof root.subject === 'function');
      return root.subject('', harness.createContext());
    };
    expect(await subjectOf('pickSubject')).toBeDefined();
    const error = await caught(Promise.resolve().then(() => subjectOf('pickWrong')));
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('CONNECTION_UNKNOWN');
  });
});

describe('static options', () => {
  it('schedule takes jitter and an inbox channel; spawn and runCode a named subprocess', () => {
    const adapter = createInMemorySubprocessAdapter();
    const hydrate = (root: WorkflowNode) =>
      hydrateWorkflow(doc(root), {
        tools: new Map(),
        executeStep: execute,
        resolveSubprocess: (ref) => (ref === 'sandbox' ? adapter : undefined),
      });
    const every = hydrate({
      kind: 'schedule',
      id: 'tick',
      step: {
        kind: 'compute',
        id: 'c',
        expr: '$',
      },
      interval: 1e3,
      jitter: 50,
      inbox: {
        name: 'pokes',
        mode: 'topic',
      },
    });
    assert(every.kind === 'schedule');
    expect(every.jitter).toBe(50);
    expect(every.inbox?.name).toBe('pokes');
    expect(every.inbox?.mode).toBe('topic');

    const child = hydrate({
      kind: 'spawn',
      id: 'child',
      child: {
        kind: 'compute',
        id: 'c',
        expr: '$',
      },
      subprocess: 'sandbox',
    });
    assert(child.kind === 'spawn');
    expect(child.subprocess).toBe(adapter);

    const code = hydrate({
      kind: 'runCode',
      id: 'fn',
      subprocess: 'sandbox',
      fromParams: {
        execute: 'work',
      },
    });
    assert(code.kind === 'runCode');
    expect(code.subprocess).toBe(adapter);

    try {
      hydrate({
        kind: 'spawn',
        id: 'child',
        child: {
          kind: 'compute',
          id: 'c',
          expr: '$',
        },
        subprocess: 'nowhere',
      });
      expect.unreachable('expected UNKNOWN_SUBPROCESS_REFERENCE');
    } catch (error) {
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('UNKNOWN_SUBPROCESS_REFERENCE');
    }
  });
});

describe('acp-agent', () => {
  it('reads every lazy option and the permission handler from params', async () => {
    const { harness } = rig({
      where: () => '/work/site',
      how: () => 'plan',
      which: () => 'opus',
      blocks: () => [
        {
          type: 'text',
          text: 'extra',
        },
      ],
      noTools: () => [],
      decide: async (request: {
        toolCall: {
          title: string;
        };
      }) => ({
        decision: 'allow',
        optionId: request.toolCall.title,
      }),
      notAFunction: 'allow',
    });
    const node = (onPermissionRequest: string): WorkflowNode => ({
      kind: 'acp-agent',
      id: 'fix',
      agent: 'coder',
      prompt: 'go',
      fromParams: {
        cwd: 'where',
        mode: 'how',
        model: 'which',
        content: 'blocks',
        tools: 'noTools',
        onPermissionRequest,
      },
    });
    const hydrate = (root: WorkflowNode) =>
      hydrateWorkflow(doc(root), {
        tools: new Map(),
        executeStep: execute,
        acpAgents: new Map([
          [
            'coder',
            {
              specificationVersion: 'acp-v1' as const,
              agentId: 'coder',
              async connect() {
                throw new Error('never connected');
              },
            },
          ],
        ]),
      });
    const step = hydrate(node('decide'));
    assert(step.kind === 'acp-agent');
    const ctx = harness.createContext();
    const read = async (option: unknown): Promise<unknown> => {
      assert(typeof option === 'function');
      return option(ctx);
    };
    expect(await read(step.cwd)).toBe('/work/site');
    expect(await read(step.mode)).toBe('plan');
    expect(await read(step.model)).toBe('opus');
    expect(await read(step.tools)).toEqual([]);
    expect(await read(step.content)).toEqual([
      {
        type: 'text',
        text: 'extra',
      },
    ]);
    assert(step.onPermissionRequest);
    const request = {
      toolCall: {
        title: 'yes',
      },
    };
    const info = {
      agentId: 'coder',
      stepId: 'fix',
    };
    expect(
      await step.onPermissionRequest(
        JSON.parse(JSON.stringify(request)),
        ctx,
        JSON.parse(JSON.stringify(info)),
      ),
    ).toEqual({
      decision: 'allow',
      optionId: 'yes',
    });

    const bad = hydrate(node('notAFunction'));
    assert(bad.kind === 'acp-agent');
    assert(bad.onPermissionRequest);
    const error = await caught(
      bad.onPermissionRequest(
        JSON.parse(JSON.stringify(request)),
        ctx,
        JSON.parse(JSON.stringify(info)),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('PARAM_NOT_A_FUNCTION');
  });

  it('a document the host did not write may not read cwd from a param, granted or not', async () => {
    const { harness } = rig({
      where: () => '/etc',
    });
    const error = await caught(
      parseAndRunWorkflow({
        json: doc({
          kind: 'acp-agent',
          id: 'fix',
          agent: 'coder',
          prompt: 'go',
          fromParams: {
            cwd: 'where',
          },
        }),
        harness,
        ctx: harness.createContext(),
        tools: [],
        input: '',
        params: [
          'where',
        ],
        acp: {
          coder: {
            cwd: '/work/sandbox',
          },
        },
      }),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('PARAM_NOT_ALLOWED');
  });
});

describe('inside a subflow or a fan-out', () => {
  const PICK: WorkflowNode = {
    kind: 'conditional',
    id: 'pick',
    fromParams: {
      route: 'pickRoute',
    },
    routes: [
      {
        target: {
          kind: 'compute',
          id: 'small',
          expr: "'small'",
        },
      },
      {
        target: {
          kind: 'compute',
          id: 'big',
          expr: "'big'",
        },
      },
    ],
  };

  it('a route function still names its target by the id the document wrote', async () => {
    const { harness } = rig({
      pickRoute: () => 'big',
    });
    expect(
      await run(
        harness,
        doc({
          kind: 'subflow',
          id: 'sub',
          document: {
            version: 1,
            root: PICK,
          },
        }),
      ),
    ).toBe('big');
    expect(
      await run(
        harness,
        doc({
          kind: 'inParallel',
          id: 'fan',
          mode: 'all',
          each: {
            kind: 'subflow',
            id: 'inner',
            document: {
              version: 1,
              root: PICK,
            },
          },
          merge: 'concat',
        }),
        {
          input: '[1,2]',
        },
      ),
    ).toBe('big\nbig');
  });

  it("leaves an output schema's own data alone", async () => {
    const schema = {
      type: 'object',
      properties: {
        ref: {
          type: 'object',
          examples: [
            {
              kind: 'k',
              id: 'i',
            },
          ],
        },
      },
    };
    const { harness, requests } = rig({}, '{"ref":{"kind":"k","id":"i"}}');
    await run(
      harness,
      doc({
        kind: 'subflow',
        id: 'sub',
        document: {
          version: 1,
          root: {
            kind: 'callModel',
            id: 'ask',
            output: {
              schema,
            },
          },
        },
      }),
    );
    expect(requests[0]?.outputJsonSchema).toEqual(schema);
  });
});

describe('what a function gives', () => {
  it('an until function must give a verdict', async () => {
    const { harness } = rig({
      enough: () => true,
    });
    const error = rootCause(
      await caught(
        run(
          harness,
          doc({
            kind: 'loop',
            id: 'tries',
            body: {
              kind: 'compute',
              id: 'try',
              expr: '$',
            },
            until: {
              kind: 'param',
              name: 'enough',
            },
            maxIterations: 3,
          }),
        ),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('INVALID_UNTIL_VERDICT');
  });

  it('a plain object with a `then` key is a value, not a promise', async () => {
    const { harness } = rig({
      // Parsed, not written: a literal with a `then` key reads as a thenable to lint.
      next: () => JSON.parse('{"if":1,"then":"go"}'),
    });
    const root = hydrateWorkflow(
      doc({
        kind: 'loop',
        id: 'tries',
        body: {
          kind: 'compute',
          id: 'try',
          expr: '$',
        },
        until: {
          kind: 'maxSteps',
          n: 2,
        },
        fromParams: {
          prepareNext: 'next',
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    expect(await harness.run(root, 'in', harness.createContext())).toBe('{"if":1,"then":"go"}');
  });

  it('fails with PARAM_MUST_BE_SYNC for a routeSwitch on and an emit filter', async () => {
    const later = {
      later: async () => 'vip',
    };
    const onError = rootCause(
      await caught(
        run(
          rig(later).harness,
          doc({
            kind: 'routeSwitch',
            id: 'switch',
            decide: {
              kind: 'decide',
              id: 'route',
              questions: TEAM,
            },
            fromParams: {
              on: 'later',
            },
            cases: {},
            default: {
              kind: 'compute',
              id: 'other',
              expr: "'x'",
            },
          }),
        ),
      ),
    );
    assert(isNoeticConfigError(onError));
    expect(onError.code).toBe('PARAM_MUST_BE_SYNC');
    const emitError = rootCause(
      await caught(
        run(
          rig(later).harness,
          doc({
            kind: 'callModel',
            id: 'ask',
            fromParams: {
              emit: 'later',
            },
          }),
        ),
      ),
    );
    assert(isNoeticConfigError(emitError));
    expect(emitError.code).toBe('PARAM_MUST_BE_SYNC');
  });

  it('fails with PARAM_NOT_A_FUNCTION for an emitItems hook that is not a function', async () => {
    const { harness } = rig({
      begin: 'nope',
    });
    const error = rootCause(
      await caught(
        run(
          harness,
          doc({
            kind: 'compute',
            id: 'c',
            expr: "'out'",
            fromParams: {
              onStart: 'begin',
            },
          }),
        ),
      ),
    );
    assert(isNoeticConfigError(error));
    expect(error.code).toBe('PARAM_NOT_A_FUNCTION');
  });

  it('gives an emitItems expression $runs', async () => {
    const { harness } = rig({});
    const root = hydrateWorkflow(
      doc({
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'loop',
            id: 'tries',
            body: {
              kind: 'compute',
              id: 'try',
              expr: '$',
            },
            until: {
              kind: 'maxSteps',
              n: 2,
            },
          },
          {
            kind: 'compute',
            id: 'report',
            expr: "'done'",
            emitItems: {
              onDone: "'ran ' & $runs.tries & ' times'",
            },
          },
        ],
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const ctx = harness.createContext();
    await harness.run(root, 'x', ctx);
    expect(JSON.stringify(ctx.itemLog.items)).toContain('ran 2 times');
  });
});

describe('what a document the host did not write cannot do', () => {
  it('turn emit off on a callModel node, by value or by a granted function', async () => {
    for (const emit of [
      {
        emit: false,
      },
      {
        fromParams: {
          emit: 'quiet',
        },
      },
    ]) {
      const { harness } = rig({
        quiet: () => false,
      });
      const ctx = harness.createContext();
      const started: unknown[] = [];
      Reflect.set(ctx, '_broadcaster', {
        emit(event: { type: string; data: Record<string, unknown> }) {
          if (event.type.endsWith('step_started')) {
            started.push(event.data.stepId);
          }
        },
      });
      await parseAndRunWorkflow({
        json: doc({
          kind: 'callModel',
          id: 'ask',
          model: 'a/b',
          ...emit,
        }),
        harness,
        ctx,
        tools: [],
        input: '',
        params: [
          'quiet',
        ],
      });
      expect(started).toContain('ask');
    }
  });

  it('widen what an agent reaches on disk', async () => {
    for (const clientCapabilities of [
      {
        allowAnyPath: true,
      },
      {
        additionalDirectories: [
          '/etc',
        ],
      },
    ]) {
      const { harness } = rig({});
      const error = await caught(
        parseAndRunWorkflow({
          json: doc({
            kind: 'acp-agent',
            id: 'fix',
            agent: 'coder',
            prompt: 'go',
            clientCapabilities,
          }),
          harness,
          ctx: harness.createContext(),
          tools: [],
          input: '',
          acp: {
            coder: {},
          },
        }),
      );
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('CONNECTION_NOT_ALLOWED');
    }
  });
});

describe('acp-agent static options', () => {
  it('takes a RegExp title as titlePattern, and the disk capabilities', () => {
    const root = hydrateWorkflow(
      doc({
        kind: 'acp-agent',
        id: 'fix',
        agent: 'coder',
        prompt: 'go',
        permissions: {
          default: 'deny',
          allow: [
            {
              kind: 'execute',
              titlePattern: '^git (status|diff)',
              titleFlags: 'i',
            },
            {
              title: 'read',
            },
          ],
        },
        clientCapabilities: {
          additionalDirectories: [
            '/work/cache',
          ],
          allowAnyPath: false,
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
        acpAgents: new Map([
          [
            'coder',
            {
              specificationVersion: 'acp-v1' as const,
              agentId: 'coder',
              async connect() {
                throw new Error('never connected');
              },
            },
          ],
        ]),
      },
    );
    assert(root.kind === 'acp-agent');
    const first = root.permissions?.allow?.[0]?.title;
    assert(first instanceof RegExp);
    expect(first.test('GIT STATUS')).toBe(true);
    expect(root.permissions?.allow?.[1]?.title).toBe('read');
    expect(root.clientCapabilities?.additionalDirectories).toEqual([
      '/work/cache',
    ]);
  });

  it('refuses a content block that is not one', () => {
    const parsed = WorkflowDocumentSchema.safeParse({
      version: 1,
      root: {
        kind: 'acp-agent',
        id: 'fix',
        agent: 'coder',
        content: [
          {
            nonsense: 1,
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a rule with both a title and a titlePattern, or a pattern that is not one', () => {
    for (const rule of [
      {
        title: 'a',
        titlePattern: 'b',
      },
      {
        titlePattern: '(',
      },
    ]) {
      const parsed = WorkflowDocumentSchema.safeParse({
        version: 1,
        root: {
          kind: 'acp-agent',
          id: 'fix',
          agent: 'coder',
          permissions: {
            allow: [
              rule,
            ],
          },
        },
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('dynamicWorkflow', () => {
  it('tells the planner the params it may read, and runs a document that reads one', async () => {
    const requests: CallModelRequest[] = [];
    const planned = doc({
      kind: 'runCode',
      id: 'shout',
      fromParams: {
        execute: 'shout',
      },
    });
    const harness = new AgentHarness({
      name: 'from-params',
      params: {
        shout: (input: string) => input.toUpperCase(),
        secret: 'k',
      },
      model: 'host/default',
      _testCallModel: async (request) => {
        requests.push(request);
        return makeLLMResponse(JSON.stringify(planned));
      },
    });
    const output = await harness.run(
      dynamicWorkflow({
        tools: [],
        params: [
          'shout',
        ],
      }),
      'hi',
      harness.createContext(),
    );
    expect(output).toBe('HI');
    expect(requests[0]?.instructions).toContain('Harness params a node may read: shout.');
    expect(requests[0]?.instructions).not.toContain('secret');
  });
});

describe('a connection from a param', () => {
  it('wait and its around steps run on the connection the function names', async () => {
    const registry: FakeRegistry = new FakeRegistry({
      team: {
        ops: {
          'chat.reply': () => {
            registry.emit('team', 'chat.message.created', {
              text: 'approve',
            });
            return {
              posted: true,
            };
          },
        },
      },
      ops: {
        ops: {
          'chat.reply': () => 'wrong connection',
        },
      },
    });
    const harness = new AgentHarness({
      name: 'from-params',
      params: {
        pickConnection: () => 'team',
      },
    });
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
    const root = hydrateWorkflow(
      {
        version: 1,
        connections: {
          team: {
            profile: 'chat@^1',
          },
          ops: {
            profile: 'chat@^1',
          },
        },
        root: {
          kind: 'wait',
          id: 'approval',
          event: 'chat.message.created',
          around: [
            {
              'chat.reply': {
                text: 'Approve?',
              },
            },
          ],
          timeoutMs: 1e3,
          fromParams: {
            connection: 'pickConnection',
          },
        },
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const output = await harness.run(root, '', harness.createContext());
    expect(JSON.stringify(output)).toContain('approve');
    expect(registry.calls.map((call) => call.connection)).toEqual([
      'team',
    ]);
  });

  it("call args a host's function gives are a step's args; a document's stay a document's", async () => {
    const registry = new FakeRegistry({
      team: {
        ops: {
          'chat.post': (args) => args,
        },
      },
    });
    const harness = new AgentHarness({
      name: 'from-params',
      params: {
        argsFor: () => ({
          text: 'hi',
        }),
      },
    });
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
    const call = (
      node: Partial<
        Extract<
          WorkflowNode,
          {
            kind: 'call';
          }
        >
      >,
    ): WorkflowDocument => ({
      version: 1,
      connections: {
        team: {
          profile: 'chat@^1',
        },
      },
      root: {
        kind: 'call',
        id: 'post',
        op: 'chat.post',
        ...node,
      },
    });
    await harness.run(
      hydrateWorkflow(
        call({
          fromParams: {
            args: 'argsFor',
          },
        }),
        {
          tools: new Map(),
          executeStep: execute,
        },
      ),
      '',
      harness.createContext(),
    );
    await harness.run(
      hydrateWorkflow(
        call({
          args: {
            text: 'hi',
          },
        }),
        {
          tools: new Map(),
          executeStep: execute,
        },
      ),
      '',
      harness.createContext(),
    );
    expect(registry.calls.map((entry) => entry.opts.caller)).toEqual([
      'step',
      'document',
    ]);
  });
});

describe('options no grant can check', () => {
  const TARGET = {
    kind: 'compute',
    id: 'c',
    expr: '$',
  } as const;
  const NODES: ReadonlyArray<
    readonly [
      string,
      WorkflowNode,
    ]
  > = [
    [
      'tools',
      {
        kind: 'callModel',
        id: 'n',
        fromParams: {
          tools: 'p',
        },
      },
    ],
    ...(
      [
        'tools',
        'cwd',
        'mode',
        'model',
        'onPermissionRequest',
      ] as const
    ).map(
      (
        option,
      ): readonly [
        string,
        WorkflowNode,
      ] => [
        option,
        {
          kind: 'acp-agent',
          id: 'n',
          agent: 'coder',
          prompt: 'go',
          fromParams: {
            [option]: 'p',
          },
        },
      ],
    ),
    [
      'connection',
      {
        kind: 'call',
        id: 'n',
        op: 'chat.post',
        fromParams: {
          connection: 'p',
        },
      },
    ],
    [
      'connection',
      {
        kind: 'wait',
        id: 'n',
        event: 'chat.message.created',
        timeoutMs: 1e3,
        fromParams: {
          connection: 'p',
        },
      },
    ],
    [
      'subject',
      {
        kind: 'verify',
        id: 'n',
        expect: [
          {
            ui: 'button "Save"',
          },
        ],
        act: TARGET,
        fromParams: {
          subject: 'p',
        },
      },
    ],
  ];

  for (const [option, node] of NODES) {
    it(`a document the host did not write may not read ${node.kind} '${option}' from a granted param`, async () => {
      const harness = new AgentHarness({
        name: 'from-params',
        params: {
          p: () => 'x',
        },
      });
      setHarnessInternals(harness, {
        connectionRegistry: new FakeRegistry({
          team: {},
        }),
      });
      const error = await caught(
        parseAndRunWorkflow({
          json: {
            version: 1,
            connections: {
              team: {
                profile: 'chat@^1',
              },
            },
            root: node,
          },
          harness,
          ctx: harness.createContext(),
          tools: [],
          input: '',
          params: [
            'p',
          ],
          connections: {
            team: {
              ops: [
                '*',
              ],
              events: [
                '*',
              ],
            },
          },
          acp: {
            coder: {},
          },
        }),
      );
      assert(isNoeticConfigError(error));
      expect(error.code).toBe('PARAM_NOT_ALLOWED');
      expect(error.message).toContain(`'${option}' of workflow node 'n'`);
    });
  }

  it('nor turn emit off on a decide node', async () => {
    const { harness } = rig({});
    const ctx = harness.createContext();
    const started: unknown[] = [];
    Reflect.set(ctx, '_broadcaster', {
      emit(event: { type: string; data: Record<string, unknown> }) {
        if (event.type.endsWith('step_started')) {
          started.push(event.data.stepId);
        }
      },
    });
    await parseAndRunWorkflow({
      json: doc({
        kind: 'decide',
        id: 'route',
        questions: TEAM,
        emit: false,
      }),
      harness,
      ctx,
      tools: [],
      input: 'help',
    });
    expect(started).toContain('route');
  });
});

describe('ids under a subflow or a fan-out', () => {
  it('gives every node its own id, whatever key holds it', async () => {
    const harness = new AgentHarness({
      name: 'from-params',
      params: {},
      decisionModel: 'host/decider',
      _testDecide: async (request): Promise<DecideResponse> => ({
        answers: {
          team: {
            type: 'choice',
            value: 'content',
            confidence: 0.9,
            probabilities: {
              content: 0.9,
              schema: 0.1,
            },
          },
        },
        source: 'native',
        modelId: request.model,
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      }),
    });
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
            each: {
              kind: 'conditional',
              id: 'pick',
              routes: [
                {
                  expr: 'true',
                  target: {
                    kind: 'routeSwitch',
                    id: 'sw',
                    decide: {
                      kind: 'decide',
                      id: 'd',
                      questions: {
                        team: {
                          type: 'choice',
                          instructions: 'Which?',
                          choices: [
                            'content',
                            'schema',
                          ],
                        },
                      },
                    },
                    on: 'team',
                    cases: {
                      content: {
                        kind: 'compute',
                        id: 'caseContent',
                        expr: "'c'",
                      },
                      schema: {
                        kind: 'compute',
                        id: 'caseSchema',
                        expr: "'s'",
                      },
                    },
                    uncertain: {
                      kind: 'compute',
                      id: 'unsure',
                      expr: "'u'",
                    },
                  },
                },
              ],
            },
            merge: 'concat',
          },
          {
            kind: 'compute',
            id: 'ids',
            expr: '$sort($keys($steps))',
          },
        ],
      }),
      {
        input: '[1,2]',
      },
    );
    assert(typeof output === 'string');
    const ids: string[] = JSON.parse(output);
    expect(ids.filter((id) => id.startsWith('caseContent'))).toEqual([
      'caseContent-0',
      'caseContent-1',
    ]);
  });

  it('leaves the args of an operation written by name as written', async () => {
    const registry = new FakeRegistry({
      app: {
        ops: {
          'ui.tap': (args) => args,
        },
      },
    });
    const harness = new AgentHarness({
      name: 'from-params',
      params: {},
    });
    setHarnessInternals(harness, {
      connectionRegistry: registry,
    });
    const root = hydrateWorkflow(
      {
        version: 1,
        connections: {
          app: {
            profile: 'ui@^1',
          },
        },
        root: {
          kind: 'subflow',
          id: 'sub',
          document: {
            version: 1,
            root: {
              kind: 'sequence',
              id: 'main',
              steps: [
                {
                  'ui.tap': {
                    kind: 'button',
                    id: 'pay',
                  },
                },
              ],
            },
          },
        },
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    await harness.run(root, '', harness.createContext());
    expect(registry.calls[0]?.args).toEqual({
      kind: 'button',
      id: 'pay',
    });
  });
});

describe('a routeSwitch decide node', () => {
  it('keeps its own options: it emits, and its answers are in $steps', async () => {
    const emitted: unknown[] = [];
    const { harness } = rig({
      note: (answers: {
        team: {
          value: string;
        };
      }) => {
        emitted.push(answers.team.value);
        return `routed to ${answers.team.value}`;
      },
    });
    const root = hydrateWorkflow(
      doc({
        kind: 'routeSwitch',
        id: 'switch',
        decide: {
          kind: 'decide',
          id: 'route',
          questions: TEAM,
          fromParams: {
            emitItems: 'note',
          },
        },
        on: 'team',
        cases: {
          auth: {
            kind: 'compute',
            id: 'auth',
            expr: '$steps.route.team.value',
          },
          billing: {
            kind: 'compute',
            id: 'billing',
            expr: "'billing'",
          },
        },
        uncertain: {
          kind: 'compute',
          id: 'unsure',
          expr: "'unsure'",
        },
      }),
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const ctx = harness.createContext();
    expect(await harness.run(root, 'help', ctx)).toBe('auth');
    expect(emitted).toEqual([
      'auth',
    ]);
    expect(JSON.stringify(ctx.itemLog.items)).toContain('routed to auth');
  });
});

describe('the static check of a verify over a list of subjects', () => {
  const tapItem = {
    'ui.tap': {
      element: 'button "Save"',
    },
  };
  const verify = (subject: string[]): WorkflowNode => ({
    kind: 'verify',
    id: 'check',
    subject,
    expect: [
      {
        ui: 'button "Save"',
      },
    ],
    act: [
      {
        kind: 'call',
        id: 'tap',
        connection: {
          $expr: '$item',
        },
        op: 'ui.tap',
        args: tapItem['ui.tap'],
      },
    ],
  });
  const manifest = (...names: string[]) =>
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          profile: 'ui@^1',
        },
      ]),
    );

  it('counts a $item call in its act on the subjects, not on every connection', () => {
    const uses = documentConnectionUses({
      version: 1,
      connections: manifest('ios', 'android', 'mailer'),
      root: verify([
        'ios',
        'android',
      ]),
    });
    expect([
      ...(uses.get('ios')?.ops ?? []),
    ]).toContain('ui.tap');
    expect([
      ...(uses.get('mailer')?.ops ?? []),
    ]).not.toContain('ui.tap');
  });

  it("counts it on the subject, not on an enclosing fan-out's connection", () => {
    const uses = documentConnectionUses({
      version: 1,
      connections: manifest('a', 'b'),
      root: {
        kind: 'inParallel',
        id: 'fan',
        mode: 'all',
        over: [
          'a',
        ],
        each: verify([
          'b',
        ]),
      },
    });
    expect([
      ...(uses.get('b')?.ops ?? []),
    ]).toContain('ui.tap');
    expect([
      ...(uses.get('a')?.ops ?? []),
    ]).not.toContain('ui.tap');
  });
});

describe('a verify over a list of subjects', () => {
  it("binds each subject's name to $item in its act", async () => {
    const { harness } = rig({});
    const root = hydrateWorkflow(
      {
        version: 1,
        connections: {
          ios: {
            profile: 'ui@^1',
          },
          android: {
            profile: 'ui@^1',
          },
        },
        root: {
          kind: 'verify',
          id: 'check',
          subject: [
            'ios',
            'android',
          ],
          expect: [
            {
              ui: 'button "Save"',
            },
          ],
          act: [
            {
              'ui.tap': {
                element: {
                  $expr: '$item',
                },
              },
            },
          ],
        },
      },
      {
        tools: new Map(),
        executeStep: execute,
      },
    );
    const taps: unknown[] = [];
    for (const id of [
      'check.ios[0]',
      'check.android[0]',
    ]) {
      const tap = lookupStep(id);
      assert(tap?.kind === 'call' && typeof tap.args === 'function');
      taps.push(await tap.args('', harness.createContext()));
    }
    expect(root.id).toBe('check');
    expect(taps).toEqual([
      {
        element: 'ios',
      },
      {
        element: 'android',
      },
    ]);
  });
});
