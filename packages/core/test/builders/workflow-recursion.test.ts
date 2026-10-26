// Named sub-workflows may recurse: a subflow node without a literal `input`
// passes its runtime input on, so the steps before a recursive call compute
// what that call receives, and a conditional picks the base case. These tests
// run real recursion end to end through a harness, with `runCode` nodes backed
// by a subprocess adapter that maps each code string to a small program.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  SpawnedSubprocess,
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessRequest,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { createInMemorySubprocessAdapter } from '../../src/adapters/in-memory-subprocess-adapter';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { workflow } from '../../src/builders/workflow-step';
import { AgentHarness } from '../../src/harness/agent-harness';

//#region Helpers

type Program = (input: string) => string;

/** `"n,acc"` → `"n-1,acc+n"`, or `"done acc"` once `n` is 0. */
const sumStep: Program = (input) => {
  const [n = 0, acc = 0] = input.split(',').map(Number);
  return n === 0 ? `done ${acc}` : `${n - 1},${acc + n}`;
};

/** Counts down; at 0 reports which workflow the count ended in. */
const tick =
  (owner: string): Program =>
  (input) => {
    const n = Number(input);
    return n === 0 ? `stop:${owner}` : String(n - 1);
  };

const PROGRAMS: Record<string, Program> = {
  'sum-step': sumStep,
  finish: (input) => input.replace('done ', ''),
  'tick-ping': tick('ping'),
  'tick-pong': tick('pong'),
  echo: (input) => input,
};

/**
 * The harness's in-memory subprocess adapter, except that `process` requests
 * (the hydrator's `runCode` nodes) run `PROGRAMS[code]` on stdin and complete
 * with its output. `step` requests still go to the in-memory adapter.
 */
function makeProgramSubprocess(): SubprocessAdapter {
  const inner = createInMemorySubprocessAdapter();
  let count = 0;
  return {
    ...inner,
    async spawn(request: SubprocessRequest): Promise<SpawnedSubprocess> {
      if (request.kind !== 'process') {
        return inner.spawn(request);
      }
      count += 1;
      const program = PROGRAMS[String(request.metadata?.code ?? '')];
      assert(program, `no program for ${String(request.metadata?.code)}`);
      const handle: SubprocessHandle = {
        id: `program-${count}`,
        status: 'running',
        startedAt: 'now',
      };
      return {
        handle,
        settled: Promise.resolve({
          ...handle,
          status: 'completed',
          metadata: {
            result: program(request.stdin ?? ''),
          },
        }),
      };
    },
  };
}

function makeHarness(): AgentHarness {
  return new AgentHarness({
    name: 'recursion-test',
    params: {},
    environment: {
      subprocess: makeProgramSubprocess(),
    },
  });
}

function run(id: string, program: string): WorkflowNode {
  return {
    kind: 'runCode',
    id,
    execute: program,
  };
}

/** Recurses into `next` until `program` emits `stopMarker`, then runs `base`. */
function recursiveDoc(opts: {
  program: string;
  stopMarker: string;
  next: string;
  base: WorkflowNode;
}): WorkflowDocument {
  return {
    version: 1,
    root: {
      kind: 'sequence',
      id: 'body',
      steps: [
        run('step', opts.program),
        {
          kind: 'conditional',
          id: 'check',
          routes: [
            {
              match: opts.stopMarker,
              target: opts.base,
            },
          ],
          default: {
            kind: 'subflow',
            id: 'recurse',
            ref: opts.next,
          },
        },
      ],
    },
  };
}

/** `sum` adds n + (n-1) + … + 1 by calling itself once per term. */
const SUM_WORKFLOWS = new Map<string, WorkflowDocument>([
  [
    'sum',
    recursiveDoc({
      program: 'sum-step',
      stopMarker: 'done',
      next: 'sum',
      base: run('finish', 'finish'),
    }),
  ],
]);

/** `ping` and `pong` call each other, so the parity of n picks where the count stops. */
const PING_PONG_WORKFLOWS = new Map<string, WorkflowDocument>([
  [
    'ping',
    recursiveDoc({
      program: 'tick-ping',
      stopMarker: 'stop',
      next: 'pong',
      base: run('report', 'echo'),
    }),
  ],
  [
    'pong',
    recursiveDoc({
      program: 'tick-pong',
      stopMarker: 'stop',
      next: 'ping',
      base: run('report', 'echo'),
    }),
  ],
]);

const CALL_SUM = {
  version: 1,
  root: {
    kind: 'subflow',
    id: 'top',
    ref: 'sum',
  },
};

async function sum(n: number, maxRecursionDepth?: number): Promise<string> {
  const harness = makeHarness();
  return parseAndRunWorkflow({
    json: CALL_SUM,
    harness,
    ctx: harness.createContext(),
    tools: [],
    input: `${n},0`,
    workflows: SUM_WORKFLOWS,
    maxRecursionDepth,
  });
}

/** Each recursion level is a step, so a deep failure nests one `step_failed` per level. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (isNoeticError(current) && current.noeticError.kind === 'step_failed') {
    current = current.noeticError.cause;
  }
  return current;
}

async function expectConfigError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (e) {
    // The harness runs the subflow wrapper as a step, so the config error
    // arrives as the cause of that step's failure.
    assert(isNoeticError(e));
    expect(e.noeticError.kind).toBe('step_failed');
    const cause = rootCause(e);
    assert(isNoeticConfigError(cause));
    expect(cause.code).toBe(code);
  }
}

//#endregion

//#region Tests

describe('recursive subflows', () => {
  it('a directly recursive workflow computes a sum and stops at its base case', async () => {
    expect(await sum(5)).toBe('15');
  });

  it('transitively recursive workflows alternate until the count runs out', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    const parity = (n: number): Promise<string> =>
      parseAndRunWorkflow({
        json: {
          version: 1,
          root: {
            kind: 'subflow',
            id: 'top',
            ref: 'ping',
          },
        },
        harness,
        ctx,
        tools: [],
        input: String(n),
        workflows: PING_PONG_WORKFLOWS,
      });
    expect(await parity(3)).toBe('stop:pong');
    expect(await parity(4)).toBe('stop:ping');
  });

  it('a recursion depth of exactly maxRecursionDepth runs', async () => {
    // sum(5) resolves `sum` six times: the top call plus five recursive calls.
    expect(await sum(5, 6)).toBe('15');
    expect(await sum(5, 7)).toBe('15');
  });

  it('one level past maxRecursionDepth throws WORKFLOW_RECURSION_LIMIT', async () => {
    await expectConfigError(sum(5, 5), 'WORKFLOW_RECURSION_LIMIT');
  });

  it('maxRecursionDepth: Infinity removes the limit', async () => {
    expect(await sum(5, Number.POSITIVE_INFINITY)).toBe('15');
  });

  it('workflow() counts its own ref toward maxRecursionDepth', async () => {
    const harness = makeHarness();
    const step = (maxRecursionDepth: number) =>
      workflow({
        id: 'sum-step',
        ref: 'sum',
        workflows: SUM_WORKFLOWS,
        maxRecursionDepth,
      });
    // sum(3): the step's own ref plus three recursive calls.
    expect(await harness.run(step(4), '3,0', harness.createContext())).toBe('6');
    await expectConfigError(
      harness.run(step(3), '3,0', harness.createContext()),
      'WORKFLOW_RECURSION_LIMIT',
    );
  });
});

//#endregion
