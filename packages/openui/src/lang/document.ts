/**
 * The materialized OpenUI Lang document model.
 *
 * OpenUI Lang is a line-oriented assignment language: one statement per line,
 * `name = expression`. This module owns only the *statement-level* view a
 * transport needs — statement boundaries, ordering, and per-statement source —
 * so the surface can serialize the document for recall and rehydration and the
 * codec can stream one framework event per completed statement.
 *
 * The *language* itself — expression parsing, the AST, reference resolution,
 * positional-to-named prop mapping, and validation — lives in
 * `@openuidev/lang-core`. This package no longer reimplements it; call
 * {@link resolveDocument} to get lang-core's resolved `ParseResult`.
 */

import type { ASTNode, ElementNode, LibraryJSONSchema, ParseResult } from '@openuidev/lang-core';
import { createParser, isASTNode } from '@openuidev/lang-core';

/** Re-exported lang-core resolved-model types — the authoritative render tree. */
export type { ASTNode, ElementNode, ParseResult };
export { isASTNode };

/** The OpenUI Lang dialect this package emits and parses. */
export const OPENUI_LANG_DIALECT = 'openui-lang/0.5';

/** The reserved assignment ref that designates the document root. */
export const ROOT_REF = 'root';

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

/** @public One assignment statement's transport-level view. */
export interface UiStatement {
  /** Assignment target. State declarations keep their `$` prefix (`'$tab'`). */
  ref: string;
  kind: UiStatementKind;
  /** Full OpenUI Lang source of this statement (`ref = <expression>`). */
  source: string;
  /** 1-indexed statement line within the turn's output. */
  line: number;
}

/** @public A non-fatal parse problem (unparseable or prose line). */
export interface UiDiagnostic {
  line: number;
  message: string;
  source: string;
}

/**
 * @public The materialized document: statements in source order, keyed by ref.
 * The mounted render tree is derived on demand via {@link resolveDocument}.
 */
export interface UiDocument {
  dialect: string;
  /** `'root'` when the document assigned the reserved root ref, else null. */
  root: string | null;
  /** Statements keyed by ref (state refs keyed with their `$` prefix). */
  statements: Record<string, UiStatement>;
  /** Refs in statement order. Re-assignment moves a ref to the end. */
  order: string[];
  diagnostics: UiDiagnostic[];
}

//#endregion

//#region Statement classification

const STATEMENT_RE = /^(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/;
const COMPONENT_CALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Split a statement line into its `ref` and right-hand-side source. */
export function splitStatement(source: string): {
  ref: string;
  rhs: string;
} | null {
  const match = STATEMENT_RE.exec(source);
  if (!match) {
    return null;
  }
  return {
    ref: match[1] ?? '',
    rhs: (match[2] ?? '').trim(),
  };
}

/** Classify a statement from its ref and right-hand side (no expression parse). */
export function classify(ref: string, rhs: string): UiStatementKind {
  if (ref.startsWith('$')) {
    return UiStatementKind.State;
  }
  const call = COMPONENT_CALL_RE.exec(rhs);
  if (call) {
    if (call[1] === 'Query') {
      return UiStatementKind.Query;
    }
    if (call[1] === 'Mutation') {
      return UiStatementKind.Mutation;
    }
    return UiStatementKind.Component;
  }
  return UiStatementKind.Value;
}

//#endregion

//#region Accessors

export function emptyDocument(dialect: string = OPENUI_LANG_DIALECT): UiDocument {
  return {
    dialect,
    root: null,
    statements: {},
    order: [],
    diagnostics: [],
  };
}

function statementsOfKind(doc: UiDocument, ...kinds: UiStatementKind[]): UiStatement[] {
  const wanted = new Set<UiStatementKind>(kinds);
  return doc.order
    .map((ref) => doc.statements[ref])
    .filter((s): s is UiStatement => s !== undefined && wanted.has(s.kind));
}

/** Component-node statements (`Query`/`Mutation` excluded). */
export function documentNodes(doc: UiDocument): UiStatement[] {
  return statementsOfKind(doc, UiStatementKind.Component);
}

/** `$state` declarations. */
export function documentState(doc: UiDocument): UiStatement[] {
  return statementsOfKind(doc, UiStatementKind.State);
}

/** `Query` / `Mutation` data bindings. */
export function documentData(doc: UiDocument): UiStatement[] {
  return statementsOfKind(doc, UiStatementKind.Query, UiStatementKind.Mutation);
}

/**
 * Fold a newer document's statements onto a base document. Re-assigned refs are
 * replaced and move to the end of statement order (matching streaming
 * re-assignment semantics); diagnostics accumulate.
 */
export function mergeDocument(base: UiDocument, incoming: UiDocument): UiDocument {
  const merged: UiDocument = {
    dialect: base.dialect,
    root: incoming.root ?? base.root,
    statements: {
      ...base.statements,
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
    const statement = incoming.statements[ref];
    if (!statement) {
      continue;
    }
    if (merged.statements[ref] !== undefined) {
      merged.order.splice(merged.order.indexOf(ref), 1);
    }
    merged.statements[ref] = statement;
    merged.order.push(ref);
  }
  return merged;
}

//#endregion

//#region Serialization

/** Serialize one statement as an OpenUI Lang line. */
export function serializeStatement(statement: UiStatement): string {
  return statement.source;
}

/**
 * Serialize the whole document back to OpenUI Lang source (statement order
 * preserved). Used by the transport to rehydrate a reconnecting client from
 * the layer-state snapshot instead of replaying the LLM stream.
 */
export function serializeDocument(doc: UiDocument): string {
  return doc.order
    .map((ref) => doc.statements[ref])
    .filter((s): s is UiStatement => s !== undefined)
    .map(serializeStatement)
    .join('\n');
}

//#endregion

//#region Resolution (lang-core)

const EMPTY_SCHEMA: LibraryJSONSchema = {
  $defs: {},
};

/**
 * Resolve a document to lang-core's `ParseResult` — the mounted render tree
 * with references resolved and positional args mapped to named props. Pass a
 * compiled library schema (`library.toJSONSchema()`) so props map correctly and
 * validation runs; without one, components render as opaque nodes.
 */
export function resolveDocument(doc: UiDocument, schema?: LibraryJSONSchema): ParseResult {
  const source = serializeDocument(doc);
  return createParser(schema ?? EMPTY_SCHEMA).parse(source);
}

//#endregion
