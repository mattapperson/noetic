import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { WorkflowDocument, WorkflowNode } from '@noetic-tools/core';
import type { GraphEdge, GraphNode } from '../lib/workflow-graph';
import { describeUntil, toFlow } from '../lib/workflow-graph';

//#region Fixtures

function doc(root: WorkflowNode): WorkflowDocument {
  return {
    version: 1,
    root,
  };
}

/**
 * A document shaped like something read back from durable storage: it satisfies
 * the envelope check the viewer performs but not the full node schema, which is
 * exactly what the projection has to survive.
 */
function frameworkShaped(value: unknown): WorkflowDocument {
  // @ts-expect-error — the point of the fixture is that it is not a valid document
  return value;
}

function callModel(id: string, instructions = 'do the thing'): WorkflowNode {
  return {
    kind: 'callModel',
    id,
    instructions,
  };
}

function node(nodes: GraphNode[], id: string): GraphNode {
  const found = nodes.find((candidate) => candidate.id === id);
  assert(found, `no node "${id}"`);
  return found;
}

/** Every node id reachable in one hop from `from`. */
function targets(edges: GraphEdge[], from: string): string[] {
  return edges.filter((edge) => edge.from === from).map((edge) => edge.to);
}

function sources(edges: GraphEdge[], to: string): string[] {
  return edges.filter((edge) => edge.to === to).map((edge) => edge.from);
}

//#endregion

describe('toFlow', () => {
  it('brackets a lone leaf with start and end terminals', () => {
    const { nodes, edges } = toFlow(doc(callModel('only')));

    expect(nodes.map((n) => n.id)).toEqual([
      '~start',
      'only',
      '~end',
    ]);
    expect(targets(edges, '~start')).toEqual([
      'only',
    ]);
    expect(targets(edges, 'only')).toEqual([
      '~end',
    ]);
  });

  it('draws a sequence as a chain, with no node of its own', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'sequence',
        id: 'seq',
        steps: [
          callModel('a'),
          callModel('b'),
          callModel('c'),
        ],
      }),
    );

    // The sequence imposes the shape; it is not drawn.
    expect(nodes.some((n) => n.id === 'seq')).toBe(false);
    expect(targets(edges, 'a')).toEqual([
      'b',
    ]);
    expect(targets(edges, 'b')).toEqual([
      'c',
    ]);
    expect(targets(edges, 'c')).toEqual([
      '~end',
    ]);
  });

  it('splits an inParallel node into paths and rejoins them at a join carrying the merge strategy', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'inParallel',
        id: 'fan',
        mode: 'all',
        merge: 'concat',
        paths: [
          callModel('left'),
          callModel('right'),
        ],
      }),
    );

    expect(targets(edges, 'fan').sort()).toEqual([
      'left',
      'right',
    ]);
    expect(sources(edges, 'fan~join').sort()).toEqual([
      'left',
      'right',
    ]);
    expect(node(nodes, 'fan').chips).toContain('all');
    expect(node(nodes, 'fan~join').chips).toContain('merge concat');
  });

  it('marks a dynamic inParallel node as one path standing for many', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'inParallel',
        id: 'fan',
        mode: 'all',
        each: callModel('body'),
        over: 'items',
      }),
    );

    expect(node(nodes, 'fan').detail).toBe('each item of items');
    expect(edges.find((edge) => edge.to === 'body')?.label).toBe('per item');
  });

  it('numbers conditional routes, because the first match wins', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'conditional',
        id: 'gate',
        routes: [
          {
            match: 'yes',
            target: callModel('approve'),
          },
          {
            match: 'yes please',
            target: callModel('shadowed'),
          },
        ],
      }),
    );

    // The runtime tests routes in order, so "yes please" can never win. Drawing
    // both as unlabelled alternatives would hide that.
    expect(edges.find((edge) => edge.to === 'approve')?.label).toBe('1. "yes"');
    expect(edges.find((edge) => edge.to === 'shadowed')?.label).toBe('2. "yes please"');
    expect(node(nodes, 'gate').detail).toContain('first match wins');
    // No default route: falling through the gate must still reach the end.
    expect(targets(edges, 'gate')).toContain('~end');
  });

  it('routes a conditional default without labelling it as a match', () => {
    const { edges } = toFlow(
      doc({
        kind: 'conditional',
        id: 'gate',
        routes: [
          {
            match: 'yes',
            target: callModel('approve'),
          },
        ],
        default: callModel('fallback'),
      }),
    );

    expect(edges.find((edge) => edge.to === 'fallback')?.label).toBe('default');
    // With a default every path is covered, so the gate no longer exits directly.
    expect(targets(edges, 'gate')).not.toContain('~end');
  });

  it('draws a loop as a do-while: body first, then the test', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'loop',
        id: 'until-done',
        body: callModel('work'),
        until: {
          kind: 'maxSteps',
          n: 5,
        },
        maxIterations: 10,
      }),
    );

    expect(node(nodes, 'until-done').chips).toEqual([
      'until 5 steps',
      'max 10',
    ]);
    // The runtime always runs the body once before testing, so flow enters the
    // body — entering the gate would imply the body can be skipped.
    expect(targets(edges, '~start')).toEqual([
      'work',
    ]);
    expect(targets(edges, 'work')).toContain('until-done');
    const back = edges.find((edge) => edge.from === 'until-done' && edge.to === 'work');
    assert(back);
    expect(back.variant).toBe('back');
    expect(back.label).toBe('repeat');
    // Flow leaves from the gate, once the predicate holds.
    expect(targets(edges, 'until-done')).toContain('~end');
  });

  it('shows the interpreter default when a loop has no explicit cap', () => {
    const { nodes } = toFlow(
      doc({
        kind: 'loop',
        id: 'forever',
        body: callModel('work'),
        until: {
          kind: 'noToolCalls',
        },
      }),
    );

    // The ceiling exists whether or not the author wrote one, and hitting it
    // fails the step — an invisible limit is how a plan dies unexpectedly.
    expect(node(nodes, 'forever').chips).toContain('max 1000 (default)');
  });

  it('gives `schedule` no exit, because it never returns', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'sequence',
        id: 'seq',
        steps: [
          {
            kind: 'schedule',
            id: 'tick',
            step: callModel('poll'),
            interval: 1e3,
          },
          callModel('unreachable'),
        ],
      }),
    );

    // The schedule interpreter only returns by throwing, so nothing downstream can run.
    // Drawing an edge to it would promise a step that never happens.
    expect(targets(edges, 'tick')).toEqual([
      'poll',
    ]);
    expect(sources(edges, 'unreachable')).toEqual([]);
    expect(sources(edges, '~end')).toEqual([]);
    expect(node(nodes, 'tick').detail).toContain('runs forever');
  });

  it('does not label a race join with a merge strategy', () => {
    const { nodes } = toFlow(
      doc({
        kind: 'inParallel',
        id: 'first',
        mode: 'race',
        merge: 'concat',
        paths: [
          callModel('a'),
          callModel('b'),
        ],
      }),
    );

    // A race aborts the losers and never merges, whatever the document says.
    const join = node(nodes, 'first~join');
    expect(join.title).toBe('first wins');
    expect(join.chips).toEqual([
      'losers aborted',
    ]);
  });

  it('draws an inline subflow instead of hiding its subtree', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'subflow',
        id: 'inline',
        document: doc({
          kind: 'sequence',
          id: 'inner',
          steps: [
            callModel('first'),
            callModel('second'),
          ],
        }),
      }),
    );

    // An inline document has no named workflow to open, so drawing it as an
    // opaque leaf would lose the only copy of it.
    expect(nodes.map((n) => n.id)).toContain('first');
    expect(nodes.map((n) => n.id)).toContain('second');
    expect(targets(edges, 'inline')).toEqual([
      'first',
    ]);
    expect(targets(edges, 'second')).toEqual([
      '~end',
    ]);
  });

  it('draws a malformed node rather than throwing', () => {
    // Documents come back from durable storage unvalidated, so a node missing
    // its children must not take the viewer down with it.
    const { nodes } = toFlow(
      frameworkShaped({
        version: 1,
        root: {
          kind: 'sequence',
          id: 'broken',
        },
      }),
    );

    const broken = node(nodes, 'broken');
    expect(broken.kind).toBe('malformed');
    expect(broken.detail).toContain('no steps');
  });

  it('draws each remaining leaf kind with its own identifying content', () => {
    const { nodes } = toFlow(
      doc({
        kind: 'sequence',
        id: 'seq',
        steps: [
          {
            kind: 'runCode',
            id: 'script',
            execute: 'echo hi',
            retry: {
              maxAttempts: 3,
              backoff: 'fixed',
              initialDelay: 10,
            },
          },
          {
            kind: 'withContext',
            id: 'scoped',
            layers: [
              'notes',
            ],
            child: {
              kind: 'acp-agent',
              id: 'agent',
              agent: 'codex',
              prompt: 'do it',
              model: 'default',
              mode: 'default',
            },
          },
        ],
      }),
    );

    expect(node(nodes, 'script').detail).toBe('echo hi');
    expect(node(nodes, 'script').chips).toEqual([
      'retry ×3',
    ]);
    expect(node(nodes, 'scoped').chips).toEqual([
      'layers: notes',
    ]);
    // Chips name their field, so two fields holding "default" stay distinct.
    expect(node(nodes, 'agent').chips).toEqual([
      'agent codex',
      'model default',
      'mode default',
    ]);
  });

  it('marks the edge into a spawned child as crossing into another context', () => {
    const { nodes, edges } = toFlow(
      doc({
        kind: 'spawn',
        id: 'child',
        child: callModel('inner'),
        timeout: 3e4,
      }),
    );

    expect(node(nodes, 'child').chips).toEqual([
      'inherits layers',
      'timeout 30000ms',
    ]);
    expect(edges.find((edge) => edge.to === 'inner')?.variant).toBe('isolated');
    // The child's result is the spawn's result, so flow continues from it.
    expect(targets(edges, 'inner')).toEqual([
      '~end',
    ]);
  });

  it('keeps a subflow ref a leaf and carries the name it points at', () => {
    const { nodes } = toFlow(
      doc({
        kind: 'subflow',
        id: 'detail',
        ref: 'run-tests',
      }),
    );

    const subflow = node(nodes, 'detail');
    expect(subflow.ref).toBe('run-tests');
    expect(subflow.detail).toBe('→ run-tests');
  });

  it('gives colliding node ids distinct graph ids', () => {
    const { nodes } = toFlow(
      doc({
        kind: 'sequence',
        id: 'seq',
        steps: [
          callModel('same'),
          callModel('same'),
        ],
      }),
    );

    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('same');
    expect(ids).toContain('same#2');
  });

  it('clips a long instruction to a single line', () => {
    const { nodes } = toFlow(doc(callModel('wordy', `first\nsecond ${'x'.repeat(300)}`)));

    const detail = node(nodes, 'wordy').detail;
    assert(detail !== undefined);
    expect(detail).not.toContain('\n');
    expect(detail.endsWith('…')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(121);
  });
});

describe('describeUntil', () => {
  it('names each predicate', () => {
    expect(
      describeUntil({
        kind: 'maxSteps',
        n: 3,
      }),
    ).toBe('3 steps');
    expect(
      describeUntil({
        kind: 'noToolCalls',
      }),
    ).toBe('no tool calls');
    expect(
      describeUntil({
        kind: 'outputContains',
        marker: 'DONE',
      }),
    ).toBe('output has "DONE"');
    expect(
      describeUntil({
        kind: 'converged',
      }),
    ).toBe('converged');
    expect(
      describeUntil({
        kind: 'converged',
        threshold: 0.9,
      }),
    ).toBe('converged ≥ 0.9');
  });

  it('joins combinators with their own conjunction', () => {
    expect(
      describeUntil({
        kind: 'any',
        predicates: [
          {
            kind: 'noToolCalls',
          },
          {
            kind: 'maxSteps',
            n: 2,
          },
        ],
      }),
    ).toBe('no tool calls or 2 steps');
    expect(
      describeUntil({
        kind: 'all',
        predicates: [
          {
            kind: 'noToolCalls',
          },
          {
            kind: 'maxCost',
            usd: 1,
          },
        ],
      }),
    ).toBe('no tool calls and $1');
  });
});
