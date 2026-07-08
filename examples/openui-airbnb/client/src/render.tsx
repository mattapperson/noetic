/**
 * The renderer: walk a noetic `UiDocument` (produced by the framework's own
 * `parseDocument`) and materialize it as React. Component calls resolve against
 * the styled Airbnb REGISTRY; `Action`/`@ToAssistant` builtins become click
 * handlers that drive the next agent turn. The client owns no UI state — it is
 * a pure projection of the server surface.
 */

import type { UiDocument, UiExpr } from '@openui/document';
import type { ReactNode } from 'react';
import { REGISTRY } from './components';
import type { RenderContext } from './types';

//#region Context

interface ActionStep {
  kind: 'toAssistant' | 'set' | 'run';
  message?: string;
  name?: string;
  value?: unknown;
  ref?: string;
}

const ACTION_STEP_FNS = new Set([
  'Run',
  'Set',
  'ToAssistant',
]);

//#endregion

//#region Evaluation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pluck(base: unknown, path: string[]): unknown {
  let value = base;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/** Evaluate an action-step builtin (`@ToAssistant` / `@Set` / `@Run`) to a descriptor. */
function evalActionStep(
  expr: Extract<
    UiExpr,
    {
      kind: 'call';
    }
  >,
  doc: UiDocument,
  ctx: RenderContext,
): ActionStep {
  if (expr.fn === 'ToAssistant') {
    return {
      kind: 'toAssistant',
      message: String(evalExpr(expr.args[0], doc, ctx) ?? ''),
    };
  }
  if (expr.fn === 'Set') {
    const target = expr.args[0];
    const name = target?.kind === 'state-ref' ? target.name : String(evalExpr(target, doc, ctx));
    return {
      kind: 'set',
      name,
      value: evalExpr(expr.args[1], doc, ctx),
    };
  }
  const ref = expr.args[0];
  return {
    kind: 'run',
    ref: ref?.kind === 'ref' ? ref.name : undefined,
  };
}

/** Turn an `Action([...])` into a click handler that dispatches its steps. */
function makeActionHandler(steps: ActionStep[], ctx: RenderContext): () => void {
  return () => {
    for (const step of steps) {
      if (step.kind === 'set' && step.name) {
        ctx.onSet(step.name, step.value);
      }
      if (step.kind === 'toAssistant' && step.message) {
        ctx.onIntent(step.message);
      }
    }
  };
}

function evalCall(
  expr: Extract<
    UiExpr,
    {
      kind: 'call';
    }
  >,
  doc: UiDocument,
  ctx: RenderContext,
): unknown {
  if (expr.fn === 'Action') {
    const list = expr.args[0];
    const stepExprs = list?.kind === 'array' ? list.items : [];
    const steps = stepExprs
      .filter(
        (
          e,
        ): e is Extract<
          UiExpr,
          {
            kind: 'call';
          }
        > => e.kind === 'call' && ACTION_STEP_FNS.has(e.fn),
      )
      .map((e) => evalActionStep(e, doc, ctx));
    return makeActionHandler(steps, ctx);
  }
  // Query / Mutation bindings resolve server-side in this demo (the model bakes
  // literal values), so an unresolved data binding renders as nothing.
  if (expr.fn === 'Query' || expr.fn === 'Mutation') {
    return undefined;
  }
  return renderComponent(expr, doc, ctx);
}

function evalExpr(expr: UiExpr | undefined, doc: UiDocument, ctx: RenderContext): unknown {
  if (!expr) {
    return undefined;
  }
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'state-ref':
      return ctx.vars[expr.name];
    case 'ref':
      return evalExpr(doc.assignments[expr.name]?.expr, doc, ctx);
    case 'member':
      return pluck(evalExpr(expr.base, doc, ctx), expr.path);
    case 'array':
      return expr.items.map((item) => evalExpr(item, doc, ctx));
    case 'object':
      return Object.fromEntries(
        expr.entries.map((e) => [
          e.key,
          evalExpr(e.value, doc, ctx),
        ]),
      );
    case 'call':
      return evalCall(expr, doc, ctx);
  }
}

//#endregion

//#region Component materialization

let keySeq = 0;

function renderComponent(
  expr: Extract<
    UiExpr,
    {
      kind: 'call';
    }
  >,
  doc: UiDocument,
  ctx: RenderContext,
): ReactNode {
  const spec = REGISTRY[expr.fn];
  if (!spec) {
    return null;
  }
  const props: Record<string, unknown> = {};
  spec.props.forEach((propName, i) => {
    props[propName] = evalExpr(expr.args[i], doc, ctx);
  });
  keySeq += 1;
  return spec.render(props, ctx, `n${keySeq}`);
}

//#endregion

//#region Public API

/** Render a document's root subtree, or null when there is no root yet. */
export function renderDocument(doc: UiDocument, ctx: RenderContext): ReactNode {
  keySeq = 0;
  const rootRef = doc.root ?? undefined;
  if (!rootRef) {
    return null;
  }
  const rootExpr = doc.assignments[rootRef]?.expr;
  if (!rootExpr) {
    return null;
  }
  const node = evalExpr(rootExpr, doc, ctx);
  return isRenderable(node) ? node : null;
}

/**
 * Mid-stream fallback: before the model assigns `root` (its last line), render
 * the top-level components produced so far so cards reveal as they stream in.
 */
export function renderPartial(doc: UiDocument, ctx: RenderContext): ReactNode {
  keySeq = 0;
  const nodesOut: ReactNode[] = [];
  for (const ref of doc.order) {
    const expr = doc.assignments[ref]?.expr;
    if (expr?.kind !== 'call') {
      continue;
    }
    if (expr.fn !== 'SearchBar' && expr.fn !== 'ListingCard') {
      continue;
    }
    const node = evalExpr(expr, doc, ctx);
    if (isRenderable(node)) {
      nodesOut.push(node);
    }
  }
  return nodesOut.length > 0 ? nodesOut : null;
}

function isRenderable(value: unknown): value is ReactNode {
  return value !== undefined && value !== null && typeof value !== 'function';
}

//#endregion
