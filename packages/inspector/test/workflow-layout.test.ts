import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { WorkflowDocument, WorkflowNode } from '@noetic-tools/core';
import type { GraphNode } from '../lib/workflow-graph';
import { toFlow } from '../lib/workflow-graph';
import type { StepFlowNode } from '../lib/workflow-layout';
import { FlowDirection, Handles, layoutFlow, nodeHeight, nodeWidth } from '../lib/workflow-layout';

//#region Fixtures

function doc(root: WorkflowNode): WorkflowDocument {
  return {
    version: 1,
    root,
  };
}

function callModel(id: string): WorkflowNode {
  return {
    kind: 'callModel',
    id,
    instructions: 'do the thing',
  };
}

function placed(nodes: StepFlowNode[], id: string): StepFlowNode {
  const found = nodes.find((node) => node.id === id);
  assert(found, `no node "${id}"`);
  return found;
}

const CHAIN = doc({
  kind: 'sequence',
  id: 'seq',
  steps: [
    callModel('a'),
    callModel('b'),
  ],
});

//#endregion

describe('layoutFlow', () => {
  it('ranks a chain down the canvas when flowing down', () => {
    const { nodes } = layoutFlow(toFlow(CHAIN), FlowDirection.Down);

    expect(placed(nodes, 'a').position.y).toBeLessThan(placed(nodes, 'b').position.y);
    expect(placed(nodes, '~start').position.y).toBeLessThan(placed(nodes, 'a').position.y);
  });

  it('ranks the same chain across the canvas when flowing right', () => {
    const { nodes } = layoutFlow(toFlow(CHAIN), FlowDirection.Right);

    expect(placed(nodes, 'a').position.x).toBeLessThan(placed(nodes, 'b').position.x);
  });

  it('ranks a loop body above its gate — the back edge must not reverse the ranking', () => {
    const flow = toFlow(
      doc({
        kind: 'loop',
        id: 'gate',
        body: callModel('work'),
        until: {
          kind: 'noToolCalls',
        },
      }),
    );
    const { nodes, edges } = layoutFlow(flow, FlowDirection.Down);

    // The loop is a do-while, so the body comes first and the test follows it.
    // If the back edge were fed to dagre it would break the cycle somewhere of
    // its own choosing and this ordering would flip.
    expect(placed(nodes, 'work').position.y).toBeLessThan(placed(nodes, 'gate').position.y);

    // The return path is still drawn — it just does not rank.
    const back = edges.find((edge) => edge.source === 'gate' && edge.target === 'work');
    assert(back);
    expect(back.sourceHandle).toBe(Handles.BackOut);
    expect(back.targetHandle).toBe(Handles.BackIn);
    expect(back.animated).toBe(true);
  });

  it('gives every node the step type and its layout direction', () => {
    const { nodes } = layoutFlow(toFlow(CHAIN), FlowDirection.Right);

    for (const node of nodes) {
      expect(node.type).toBe('step');
      expect(node.data.direction).toBe(FlowDirection.Right);
    }
  });

  it('carries the reserved box onto the node, so siblings cannot overlap', () => {
    const { nodes } = layoutFlow(toFlow(CHAIN), FlowDirection.Down);

    // dagre reserves a slot per node; without the same box on the DOM node the
    // element sizes to its content and grows over the neighbour beside it.
    for (const node of nodes) {
      expect(node.style?.width).toBe(nodeWidth(node.data.node));
      expect(node.style?.height).toBe(nodeHeight(node.data.node));
    }
  });

  it('sizes a node by the content it has to show', () => {
    const bare: GraphNode = {
      id: 'bare',
      kind: 'callModel',
      shape: 'step',
      title: 'callModel',
      chips: [],
    };
    const full = {
      ...bare,
      detail: 'some instructions',
      chips: [
        'a',
        'b',
        'c',
      ],
    };

    expect(nodeHeight(full)).toBeGreaterThan(nodeHeight(bare));

    // Chips wrap two to a row, so the height steps at the boundary and only
    // there — 1 and 2 chips are one row, 3 chips are two.
    const withChips = (count: number): number =>
      nodeHeight({
        ...bare,
        chips: Array.from(
          {
            length: count,
          },
          (_, index) => `chip-${index}`,
        ),
      });
    expect(withChips(1)).toBe(withChips(2));
    expect(withChips(3)).toBeGreaterThan(withChips(2));
    expect(withChips(3)).toBe(withChips(4));
    expect(
      nodeHeight({
        id: 't',
        kind: 'start',
        shape: 'terminal',
        title: 'start',
        chips: [],
      }),
    ).toBeLessThan(nodeHeight(bare));
  });
});
