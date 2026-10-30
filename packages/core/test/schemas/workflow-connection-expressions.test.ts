// Expression validation and bindings for connection nodes (spec 33 § The Input,
// § Validation; spec 35 § JSON workflows): every `$expr`, connection expression,
// wait filter and verify subject is syntax-checked, and `$steps`/`$refId` read
// earlier outputs and refs.

import { describe, expect, it } from 'bun:test';
import type { WorkflowNode } from '@noetic-tools/types';
import { WorkflowDocumentSchema } from '@noetic-tools/types';
import { parseAndRunWorkflow } from '../../src/builders/dynamic-workflow';
import { expressionErrors } from '../../src/expression/check';
import { compileExpression, computeMaybe, passes } from '../../src/expression/jsonata';
import { AgentHarness } from '../../src/harness/agent-harness';

//#region Helpers

const BAD = '(((';

async function run(root: WorkflowNode, input: string): Promise<string> {
  const harness = new AgentHarness({
    name: 'bindings-test',
    params: {},
  });
  return parseAndRunWorkflow({
    json: {
      version: 1,
      root,
    },
    harness,
    ctx: harness.createContext(),
    tools: [],
    input,
  });
}

//#endregion

describe('expressionErrors over connection nodes', () => {
  it('finds bad expressions in call args, connections, wait filters, shorthand and verify subjects', () => {
    const root: WorkflowNode = {
      kind: 'sequence',
      id: 'main',
      steps: [
        {
          kind: 'call',
          id: 'c',
          connection: {
            $expr: BAD,
          },
          op: 'ui.tap',
          args: {
            nested: [
              {
                $expr: BAD,
              },
            ],
            kept: {
              $literal: {
                $expr: BAD,
              },
            },
          },
        },
        {
          kind: 'wait',
          id: 'w',
          event: 'x.y',
          filter: BAD,
          around: {
            'ui.tap': {
              element: {
                $expr: BAD,
              },
            },
          },
          timeoutMs: 10,
        },
        {
          'ui.fill': {
            $expr: BAD,
          },
        },
        {
          kind: 'verify',
          id: 'v',
          subject: {
            $expr: BAD,
          },
          expect: [
            {
              ui: 'heading "Done"',
            },
          ],
          act: [
            {
              'ui.tap': {
                element: {
                  $expr: BAD,
                },
              },
            },
          ],
        },
      ],
    };
    expect(
      WorkflowDocumentSchema.safeParse({
        version: 1,
        root,
      }).success,
    ).toBe(true);
    const wheres = expressionErrors(root).map((e) => e.slice(0, e.indexOf(' does not parse')));
    expect(wheres).toEqual([
      "Expression in args of operation 'ui.fill' in node 'main'",
      "Expression in connection of call node 'c'",
      "Expression in args of call node 'c'",
      "Expression in filter of wait node 'w'",
      "Expression in args of operation 'ui.tap' in node 'w'",
      "Expression in subject of verify node 'v'",
      "Expression in args of operation 'ui.tap' in node 'v'",
    ]);
  });

  it('reports nothing for well-formed connection nodes', () => {
    expect(
      expressionErrors({
        kind: 'call',
        id: 'c',
        op: 'ui.tap',
        args: {
          element: {
            $expr: "'button ' & name",
          },
        },
      }),
    ).toEqual([]);
  });
});

describe('$steps and $refId', () => {
  it('$steps reads the outputs of earlier nodes by id, parsed as JSON', async () => {
    const output = await run(
      {
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'compute',
            id: 'first',
            expr: "{ 'n': 1 }",
          },
          {
            kind: 'compute',
            id: 'second',
            expr: "{ 'n': n + 1 }",
          },
          {
            kind: 'compute',
            id: 'total',
            expr: '$steps.first.n + $steps.second.n + n',
          },
        ],
      },
      '',
    );
    expect(output).toBe('5');
  });

  it('$steps holds only the nodes of the enclosing document, not another document run earlier in the run', async () => {
    const harness = new AgentHarness({
      name: 'bindings-test',
      params: {},
    });
    const ctx = harness.createContext();
    const runDoc = (root: WorkflowNode): Promise<string> =>
      parseAndRunWorkflow({
        json: {
          version: 1,
          root,
        },
        harness,
        ctx,
        tools: [],
        input: '',
      });
    expect(
      await runDoc({
        kind: 'compute',
        id: 'x',
        expr: "{ 'n': 41 }",
      }),
    ).toBe('{"n":41}');
    const second = await runDoc({
      kind: 'compute',
      id: 'reader',
      expr: "$exists($steps.x) ? 'leaked' : 'isolated'",
    });
    expect(second).toBe('isolated');
  });

  it('$steps is visible to conditional routes', async () => {
    const output = await run(
      {
        kind: 'sequence',
        id: 'main',
        steps: [
          {
            kind: 'compute',
            id: 'flag',
            expr: "{ 'go': true }",
          },
          {
            kind: 'compute',
            id: 'other',
            expr: "'x'",
          },
          {
            kind: 'conditional',
            id: 'pick',
            routes: [
              {
                expr: '$steps.flag.go = true',
                target: {
                  kind: 'compute',
                  id: 'yes',
                  expr: "'took the route'",
                },
              },
            ],
            default: {
              kind: 'compute',
              id: 'no',
              expr: "'default'",
            },
          },
        ],
      },
      '',
    );
    expect(output).toBe('took the route');
  });

  it('$steps is empty, not missing, before anything ran', async () => {
    const compiled = compileExpression('$count($keys($steps))', 'test');
    expect(await computeMaybe(compiled, {})).toBe(0);
  });

  it('$refId reads the id inside a ref, and gives no value for anything else', async () => {
    const ref = {
      $ref: {
        connection: 'slack',
        kind: 'chat.thread',
        id: 'T-1',
        seal: 'abc',
      },
    };
    const compiled = compileExpression('$refId(thread)', 'test');
    expect(
      await computeMaybe(compiled, {
        thread: ref,
      }),
    ).toBe('T-1');
    expect(
      await computeMaybe(compiled, {
        thread: 'T-1',
      }),
    ).toBeUndefined();
    const test = compileExpression('$refId(thread) = "T-1"', 'test');
    expect(
      await passes(test, {
        thread: ref,
      }),
    ).toBe(true);
  });

  it('$item is bound only when given', async () => {
    const compiled = compileExpression('$item', 'test');
    expect(await computeMaybe(compiled, {})).toBeUndefined();
    expect(
      await computeMaybe(
        compiled,
        {},
        {
          item: 'ios',
        },
      ),
    ).toBe('ios');
  });
});
