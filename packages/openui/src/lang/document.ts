/**
 * The materialized OpenUI Lang document model.
 *
 * OpenUI Lang is a line-oriented assignment language: one statement per line,
 * `name = expression`. A document is the ordered set of assignments a turn
 * produced — component nodes, `$state` declarations, `Query`/`Mutation` data
 * bindings, and plain value aliases.
 */

/** The OpenUI Lang dialect this package emits and parses. */
export const OPENUI_LANG_DIALECT = 'openui-lang/0.5';

/** The reserved assignment ref that designates the document root. */
export const ROOT_REF = 'root';

//#region Expressions

export type UiLiteralValue = string | number | boolean | null;

/** @public Expression tree for one assignment's right-hand side. */
export type UiExpr =
  | {
      kind: 'literal';
      value: UiLiteralValue;
    }
  | {
      kind: 'ref';
      name: string;
    }
  | {
      kind: 'state-ref';
      name: string;
    }
  | {
      kind: 'member';
      base: UiExpr;
      path: string[];
    }
  | {
      kind: 'array';
      items: UiExpr[];
    }
  | {
      kind: 'object';
      entries: Array<{
        key: string;
        value: UiExpr;
      }>;
    }
  | {
      kind: 'call';
      fn: string;
      builtin: boolean;
      args: UiExpr[];
    };

//#endregion

//#region Statements

/** @public Classification of one assignment statement. */
export const UiStatementKind = {
  Component: 'component',
  Query: 'query',
  Mutation: 'mutation',
  State: 'state',
  Value: 'value',
} as const;

export type UiStatementKind = (typeof UiStatementKind)[keyof typeof UiStatementKind];

/** @public One parsed assignment statement. */
export interface UiAssignment {
  /** Assignment target. State declarations keep their `$` prefix (`'$tab'`). */
  ref: string;
  kind: UiStatementKind;
  expr: UiExpr;
  /** 1-indexed statement line within the turn's output. */
  line: number;
}

/** @public A non-fatal parse problem (unparseable or prose line). */
export interface UiDiagnostic {
  line: number;
  message: string;
  source: string;
}

/** @public The materialized document — the mounted tree plus state and data bindings. */
export interface UiDocument {
  dialect: string;
  /** `'root'` when the document assigned the reserved root ref, else null. */
  root: string | null;
  /** Assignments keyed by ref (state refs keyed with their `$` prefix). */
  assignments: Record<string, UiAssignment>;
  /** Refs in statement order. Re-assignment moves a ref to the end. */
  order: string[];
  diagnostics: UiDiagnostic[];
}

//#endregion

//#region Accessors

export function emptyDocument(dialect: string = OPENUI_LANG_DIALECT): UiDocument {
  return {
    dialect,
    root: null,
    assignments: {},
    order: [],
    diagnostics: [],
  };
}

/** Component-node assignments (component calls, `Query`/`Mutation` excluded). */
export function documentNodes(doc: UiDocument): UiAssignment[] {
  return doc.order
    .map((ref) => doc.assignments[ref])
    .filter((a): a is UiAssignment => a !== undefined && a.kind === UiStatementKind.Component);
}

/** `$state` declarations. */
export function documentState(doc: UiDocument): UiAssignment[] {
  return doc.order
    .map((ref) => doc.assignments[ref])
    .filter((a): a is UiAssignment => a !== undefined && a.kind === UiStatementKind.State);
}

/** `Query` / `Mutation` data bindings. */
export function documentData(doc: UiDocument): UiAssignment[] {
  return doc.order
    .map((ref) => doc.assignments[ref])
    .filter(
      (a): a is UiAssignment =>
        a !== undefined &&
        (a.kind === UiStatementKind.Query || a.kind === UiStatementKind.Mutation),
    );
}

/**
 * Fold a newer document's assignments onto a base document. Re-assigned refs
 * are replaced and move to the end of statement order (matching streaming
 * re-assignment semantics); diagnostics accumulate.
 */
export function mergeDocument(base: UiDocument, incoming: UiDocument): UiDocument {
  const merged: UiDocument = {
    dialect: base.dialect,
    root: incoming.root ?? base.root,
    assignments: {
      ...base.assignments,
    },
    order: [
      ...base.order,
    ],
    diagnostics: [
      ...base.diagnostics,
      ...incoming.diagnostics,
    ],
  };
  for (const ref of incoming.order) {
    const assignment = incoming.assignments[ref];
    if (!assignment) {
      continue;
    }
    if (merged.assignments[ref] !== undefined) {
      merged.order.splice(merged.order.indexOf(ref), 1);
    }
    merged.assignments[ref] = assignment;
    merged.order.push(ref);
  }
  return merged;
}

//#endregion

//#region Serialization

/** Serialize an expression back to OpenUI Lang source. */
export function serializeExpr(expr: UiExpr): string {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'string' ? JSON.stringify(expr.value) : String(expr.value);
    case 'ref':
      return expr.name;
    case 'state-ref':
      return `$${expr.name}`;
    case 'member':
      return `${serializeExpr(expr.base)}.${expr.path.join('.')}`;
    case 'array':
      return `[${expr.items.map(serializeExpr).join(', ')}]`;
    case 'object':
      return `{${expr.entries.map((e) => `${e.key}: ${serializeExpr(e.value)}`).join(', ')}}`;
    case 'call':
      return `${expr.builtin ? '@' : ''}${expr.fn}(${expr.args.map(serializeExpr).join(', ')})`;
  }
}

/** Serialize one assignment as a statement line. */
export function serializeAssignment(assignment: UiAssignment): string {
  return `${assignment.ref} = ${serializeExpr(assignment.expr)}`;
}

/**
 * Serialize the whole document back to OpenUI Lang source (statement order
 * preserved). Used by the transport to rehydrate a reconnecting client from
 * the layer-state snapshot instead of replaying the LLM stream.
 */
export function serializeDocument(doc: UiDocument): string {
  return doc.order
    .map((ref) => doc.assignments[ref])
    .filter((a): a is UiAssignment => a !== undefined)
    .map(serializeAssignment)
    .join('\n');
}

//#endregion
