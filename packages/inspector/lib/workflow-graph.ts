/**
 * Turns a `WorkflowDocument` into a control-flow graph: what runs, in what
 * order, and where the paths split and rejoin.
 *
 * This is deliberately NOT the syntax tree. `workflowGraph()` in
 * `@noetic-tools/types` draws parent→child edges, which answers "how is this
 * JSON nested" — a question nobody looking at a plan is asking. A reader wants
 * to see execution: a `sequence` reads as a chain, an `inParallel` as a split
 * and a join, a `conditional` as labelled routes off a gate, a `loop` as a
 * body with a line back to the top.
 *
 * Structural nodes therefore either vanish into the shape they impose
 * (`sequence`) or become a small gate that owns the shape (`inParallel`,
 * `conditional`, `loop`, `schedule`). A `subflow` ref stays a leaf and carries
 * the name it points at, so the viewer can open it.
 */

import type {
  LoopWorkflowNode,
  UntilPredicate,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/core';

//#region Types

/**
 * What a graph node stands for. Every `WorkflowNode` kind keeps its own name;
 * the extras are drawn by the projection: `join` closes an inParallel split,
 * `start` and `end` are the document's terminals.
 */
export type GraphNodeKind =
  | WorkflowNode['kind']
  | 'join'
  | 'start'
  | 'end'
  /** A node whose required children are missing — drawn rather than thrown over. */
  | 'malformed';

/** How a node is drawn. Steps do work, gates route it, terminals bookend it. */
export type GraphNodeShape = 'step' | 'gate' | 'terminal';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  shape: GraphNodeShape;
  /** Headline — the kind, or the harness name for a coding-agent node. */
  title: string;
  /** One line of the node's own content: instructions, tool name, ref. */
  detail?: string;
  /** Short chips: fork mode, merge strategy, layer names, iteration caps. */
  chips: string[];
  /** Named workflow this node runs. Set on `subflow` refs; the viewer opens it. */
  ref?: string;
}

/** `back` edges return to a gate (loop, schedule); `isolated` cross into a spawned context. */
export type GraphEdgeVariant = 'default' | 'back' | 'isolated';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  variant: GraphEdgeVariant;
}

export interface WorkflowFlow {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Where a projected fragment connects: one way in, and every way out. */
interface Ports {
  entry: string;
  exits: string[];
}

//#endregion

//#region Public API

/**
 * Projects a document into a control-flow graph, bracketed by start and end
 * terminals so a plan with a single leaf still reads as a flow.
 */
export function toFlow(document: WorkflowDocument): WorkflowFlow {
  const builder = new FlowBuilder();
  const start = builder.add({
    id: '~start',
    kind: 'start',
    shape: 'terminal',
    title: 'start',
    chips: [],
  });
  const body = builder.project(document.root);
  const end = builder.add({
    id: '~end',
    kind: 'end',
    shape: 'terminal',
    title: 'end',
    chips: [],
  });

  builder.connect(start, body.entry);
  for (const exit of body.exits) {
    builder.connect(exit, end);
  }
  return builder.flow();
}

/** Renders an `until` predicate as the label on a loop's back edge. */
export function describeUntil(until: UntilPredicate): string {
  switch (until.kind) {
    case 'maxSteps':
      return `${until.n} steps`;
    case 'maxCost':
      return `$${until.usd}`;
    case 'maxDuration':
      return `${until.duration}ms`;
    case 'never':
      return 'never';
    case 'noToolCalls':
      return 'no tool calls';
    case 'outputContains':
      return `output has "${until.marker}"`;
    case 'outputEquals':
      return `output is "${until.sentinel}"`;
    case 'converged':
      return until.threshold === undefined ? 'converged' : `converged ≥ ${until.threshold}`;
    case 'any':
      return until.predicates.map(describeUntil).join(' or ');
    case 'all':
      return until.predicates.map(describeUntil).join(' and ');
  }
}

//#endregion

//#region Builder

/** Longest single-line preview shown inside a node before it is cut. */
const DETAIL_CHARS = 120;

/**
 * Documents reaching the viewer from durable storage were validated when they
 * were written, not when they were read, so shape is checked before use.
 */
function isNode(value: unknown): value is WorkflowNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'id' in value &&
    typeof value.id === 'string'
  );
}

function isArray(value: unknown): value is WorkflowNode[] {
  return Array.isArray(value);
}

class FlowBuilder {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly taken = new Set<string>();

  flow(): WorkflowFlow {
    return {
      nodes: this.nodes,
      edges: this.edges,
    };
  }

  /** Adds a node under a unique id, returning the id actually used. */
  add(node: GraphNode): string {
    const id = this.uniqueId(node.id);
    this.nodes.push({
      ...node,
      id,
    });
    return id;
  }

  connect(from: string, to: string, label?: string, variant: GraphEdgeVariant = 'default'): void {
    this.edges.push({
      id: `${from}->${to}#${this.edges.length}`,
      from,
      to,
      label,
      variant,
    });
  }

  /**
   * Projects a node and returns the ports the caller wires up. Structural
   * kinds each impose a shape; everything else is a leaf the flow runs through.
   * A switch, not a registry — it is what narrows the node union without a cast.
   */
  project(node: WorkflowNode): Ports {
    // Guarded rather than trusting the type: the viewer also draws documents
    // read back from durable storage, which no schema has revalidated. A node
    // missing its children is drawn as broken, not thrown over.
    if (!isNode(node)) {
      return this.broken('malformed', 'not a workflow node');
    }
    switch (node.kind) {
      case 'sequence':
        return isArray(node.steps)
          ? this.chain(node.steps)
          : this.broken(node.id, 'sequence has no steps');
      case 'inParallel':
        return projectInParallel(this, node);
      case 'conditional':
        return isArray(node.routes)
          ? projectConditional(this, node)
          : this.broken(node.id, 'conditional has no routes');
      case 'loop':
        return isNode(node.body)
          ? projectLoop(this, node)
          : this.broken(node.id, 'loop has no body');
      case 'schedule':
        return isNode(node.step)
          ? projectSchedule(this, node)
          : this.broken(node.id, 'schedule has no step');
      case 'spawn':
        return isNode(node.child)
          ? projectSpawn(this, node)
          : this.broken(node.id, 'spawn has no child');
      case 'withContext':
        return isNode(node.child)
          ? projectWithContext(this, node)
          : this.broken(node.id, 'withContext has no child');
      case 'subflow':
        return this.subflow(node);
      default:
        return this.leaf(node);
    }
  }

  /** Chains steps so each one's exits feed the next one's entry. */
  chain(steps: WorkflowNode[]): Ports {
    const projected = steps.map((step) => this.project(step));
    for (let i = 1; i < projected.length; i++) {
      for (const exit of projected[i - 1]!.exits) {
        this.connect(exit, projected[i]!.entry);
      }
    }
    const first = projected[0];
    const last = projected[projected.length - 1];
    if (!first || !last) {
      return this.broken('empty', 'sequence has no steps');
    }
    // A step with no exits never returns, so nothing after it runs and the
    // sequence itself never completes. Later steps are still drawn — an
    // unreachable step in a plan is worth seeing — but nothing connects them.
    const stalls = projected.some((ports) => ports.exits.length === 0);
    return {
      entry: first.entry,
      exits: stalls ? [] : last.exits,
    };
  }

  /**
   * A named ref is a leaf the viewer can open. An INLINE document is a whole
   * subtree, so it is drawn: hiding it behind one opaque box would lose the
   * only copy of it — unlike a ref, there is no named workflow to switch to.
   */
  private subflow(node: SubflowNode): Ports {
    if (node.document?.root && isNode(node.document.root)) {
      const gate = this.add({
        id: node.id,
        kind: 'subflow',
        shape: 'gate',
        title: 'subflow',
        detail: 'inline workflow',
        chips: [],
      });
      const inner = this.project(node.document.root);
      this.connect(gate, inner.entry);
      return {
        entry: gate,
        exits: inner.exits,
      };
    }
    return this.leaf(node);
  }

  /** A node with no structure of its own: it is drawn, and flow passes through it. */
  private leaf(node: WorkflowNode): Ports {
    const id = this.add({
      id: node.id,
      kind: node.kind,
      shape: 'step',
      title: node.kind,
      detail: leafDetail(node),
      chips: leafChips(node),
      ref: node.kind === 'subflow' ? node.ref : undefined,
    });
    return {
      entry: id,
      exits: [
        id,
      ],
    };
  }

  /** Draws what a malformed node was meant to be, so the reader sees the hole. */
  private broken(id: string, reason: string): Ports {
    const drawn = this.add({
      id,
      kind: 'malformed',
      shape: 'step',
      title: 'malformed',
      detail: reason,
      chips: [],
    });
    return {
      entry: drawn,
      exits: [
        drawn,
      ],
    };
  }

  private uniqueId(id: string): string {
    if (!this.taken.has(id)) {
      this.taken.add(id);
      return id;
    }
    let n = 2;
    while (this.taken.has(`${id}#${n}`)) {
      n++;
    }
    const unique = `${id}#${n}`;
    this.taken.add(unique);
    return unique;
  }
}

//#endregion

//#region Kind handlers

type InParallelNode = Extract<
  WorkflowNode,
  {
    kind: 'inParallel';
  }
>;
type ConditionalNode = Extract<
  WorkflowNode,
  {
    kind: 'conditional';
  }
>;
type ScheduleNode = Extract<
  WorkflowNode,
  {
    kind: 'schedule';
  }
>;
type SubflowNode = Extract<
  WorkflowNode,
  {
    kind: 'subflow';
  }
>;
type SpawnNode = Extract<
  WorkflowNode,
  {
    kind: 'spawn';
  }
>;
type WithContextNode = Extract<
  WorkflowNode,
  {
    kind: 'withContext';
  }
>;

/** Split into every path at once, then rejoin. The join carries the merge strategy. */
function projectInParallel(builder: FlowBuilder, node: InParallelNode): Ports {
  const chips: string[] = [
    node.mode,
  ];
  if (node.concurrency !== undefined) {
    chips.push(`≤${node.concurrency} at once`);
  }
  const fork = builder.add({
    id: node.id,
    kind: 'inParallel',
    shape: 'gate',
    title: 'inParallel',
    detail: node.each ? `each item of ${node.over ?? 'the input'}` : undefined,
    chips,
  });
  // A race has no merge: the first path to finish wins and the rest are
  // aborted, so labelling the join with a merge strategy would be a lie even
  // when the document carries one.
  const join = builder.add({
    id: `${node.id}~join`,
    kind: 'join',
    shape: 'gate',
    title: node.mode === 'race' ? 'first wins' : 'join',
    chips:
      node.mode === 'race'
        ? [
            'losers aborted',
          ]
        : [
            `merge ${node.merge ?? 'last'}`,
          ],
  });

  // A dynamic inParallel node instantiates one body per runtime item, so the
  // single drawn path stands for N of them.
  const paths = node.each
    ? [
        node.each,
      ]
    : (node.paths ?? []);
  const label = node.each ? 'per item' : undefined;

  for (const path of paths) {
    const ports = builder.project(path);
    builder.connect(fork, ports.entry, label);
    for (const exit of ports.exits) {
      builder.connect(exit, join);
    }
  }
  return {
    entry: fork,
    exits: [
      join,
    ],
  };
}

/** One route runs, so the routes never rejoin — every route's exits are the conditional's. */
function projectConditional(builder: FlowBuilder, node: ConditionalNode): Ports {
  const gate = builder.add({
    id: node.id,
    kind: 'conditional',
    shape: 'gate',
    title: 'conditional',
    detail: 'first match wins, case-insensitive substring',
    chips: [],
  });
  const exits: string[] = [];
  // Routes are tested in order and the first hit wins, so the labels are
  // numbered: two routes whose matches overlap are not equal alternatives, and
  // an unnumbered graph would draw them as though they were.
  for (const [index, route] of node.routes.entries()) {
    const ports = builder.project(route.target);
    builder.connect(gate, ports.entry, `${index + 1}. "${route.match}"`);
    exits.push(...ports.exits);
  }
  if (node.default) {
    const ports = builder.project(node.default);
    builder.connect(gate, ports.entry, 'default');
    exits.push(...ports.exits);
  } else {
    // Nothing matched is a real path through the graph; drawing it stops the
    // reader assuming the routes are exhaustive.
    exits.push(gate);
  }
  return {
    entry: gate,
    exits,
  };
}

/**
 * A do-while: the body runs, THEN the predicate is tested. Flow therefore
 * enters the body, not the gate — drawing the gate first would tell the reader
 * the body can be skipped, which it never can.
 */
function projectLoop(builder: FlowBuilder, node: LoopWorkflowNode): Ports {
  const chips = [
    `until ${describeUntil(node.until)}`,
  ];
  // Without an explicit cap the interpreter still stops at a hard ceiling and
  // fails the step, so the limit is always shown — an invisible ceiling is how
  // a plan dies in a way nobody predicted.
  chips.push(node.maxIterations !== undefined ? `max ${node.maxIterations}` : 'max 1000 (default)');

  const body = builder.project(node.body);
  const gate = builder.add({
    id: node.id,
    kind: 'loop',
    shape: 'gate',
    title: 'loop',
    chips,
  });
  for (const exit of body.exits) {
    builder.connect(exit, gate);
  }
  builder.connect(gate, body.entry, 'repeat', 'back');
  return {
    entry: body.entry,
    exits: [
      gate,
    ],
  };
}

/** A timer: the step runs, and the line back says it will run again. */
function projectSchedule(builder: FlowBuilder, node: ScheduleNode): Ports {
  const chips = [
    `every ${node.interval}ms`,
  ];
  if (node.onError) {
    chips.push(`on error: ${node.onError}`);
  }
  const gate = builder.add({
    id: node.id,
    kind: 'schedule',
    shape: 'gate',
    title: 'schedule',
    detail: 'runs forever — nothing downstream of this ever runs',
    chips,
  });
  const body = builder.project(node.step);
  builder.connect(gate, body.entry);
  for (const exit of body.exits) {
    builder.connect(exit, gate, 'next tick', 'back');
  }
  // No exits: the schedule interpreter only ever returns by throwing. Anything drawn
  // downstream of a timer would be a step the reader believes will run.
  return {
    entry: gate,
    exits: [],
  };
}

/** The child runs in its own context, so the crossing edge is marked. */
function projectSpawn(builder: FlowBuilder, node: SpawnNode): Ports {
  const chips = [
    node.layers ? `layers: ${node.layers.join(', ')}` : 'inherits layers',
  ];
  if (node.timeout !== undefined) {
    chips.push(`timeout ${node.timeout}ms`);
  }
  return wrapChild(builder, {
    id: node.id,
    kind: 'spawn',
    detail: 'isolated context',
    chips,
    child: node.child,
  });
}

/** Same shape as spawn, but the change is which context layers the child sees. */
function projectWithContext(builder: FlowBuilder, node: WithContextNode): Ports {
  return wrapChild(builder, {
    id: node.id,
    kind: 'withContext',
    detail: 'child sees these layers',
    chips: [
      `layers: ${node.layers.join(', ')}`,
    ],
    child: node.child,
  });
}

interface WrapperSpec {
  id: string;
  kind: 'spawn' | 'withContext';
  detail: string;
  chips: string[];
  child: WorkflowNode;
}

/** A gate the flow passes through on its way into a differently-scoped child. */
function wrapChild(builder: FlowBuilder, spec: WrapperSpec): Ports {
  const gate = builder.add({
    id: spec.id,
    kind: spec.kind,
    shape: 'gate',
    title: spec.kind,
    detail: spec.detail,
    chips: spec.chips,
  });
  const ports = builder.project(spec.child);
  builder.connect(gate, ports.entry, undefined, 'isolated');
  return {
    entry: gate,
    exits: ports.exits,
  };
}

//#endregion

//#region Node content

function leafDetail(node: WorkflowNode): string | undefined {
  switch (node.kind) {
    case 'callModel':
      return clip(node.instructions);
    case 'invokeTool':
      return node.toolName;
    case 'runCode':
      return clip(node.execute);
    case 'subflow':
      return node.ref ? `→ ${node.ref}` : 'inline workflow';
    case 'claude-code':
    case 'codex':
    case 'opencode':
    case 'pi':
      return clip(node.prompt);
    default:
      return undefined;
  }
}

/**
 * Chips name the field they came from. A bare value tells the reader nothing
 * when two fields hold the same one — a harness node with `model: 'default'`
 * and `permissionMode: 'default'` would otherwise wear two identical pills.
 */
function leafChips(node: WorkflowNode): string[] {
  switch (node.kind) {
    case 'callModel': {
      const chips: string[] = [];
      if (node.model) {
        chips.push(`model ${node.model}`);
      }
      if (node.tools?.length) {
        chips.push(`tools ${node.tools.map((tool) => tool.type).join(', ')}`);
      }
      if (node.output) {
        chips.push(`${node.output.codec}: ${node.output.library}`);
      }
      return chips;
    }
    case 'runCode':
      return node.retry
        ? [
            `retry ×${node.retry.maxAttempts}`,
          ]
        : [];
    case 'claude-code':
    case 'codex':
    case 'opencode':
    case 'pi': {
      const chips: string[] = [];
      if (node.settings?.model) {
        chips.push(`model ${node.settings.model}`);
      }
      if (node.settings?.permissionMode) {
        chips.push(`mode ${node.settings.permissionMode}`);
      }
      if (node.session?.reuse) {
        chips.push(`session ${node.session.reuse}`);
      }
      return chips;
    }
    default:
      return [];
  }
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > DETAIL_CHARS ? `${oneLine.slice(0, DETAIL_CHARS)}…` : oneLine;
}

//#endregion
