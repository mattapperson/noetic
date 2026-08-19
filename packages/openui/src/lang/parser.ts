/**
 * Incremental OpenUI Lang statement scanner.
 *
 * The language is line-oriented — one assignment statement per line — so this
 * is a bracket- and string-aware *line assembler* (a statement whose brackets
 * span lines still assembles) that hands each completed statement to lang-core
 * for the real work. It intentionally does not parse expressions: the AST,
 * reference resolution, prop mapping, and validation all live in
 * `@openuidev/lang-core`. Prose, fences, and non-assignment lines become
 * diagnostics, never throws — models are imperfect.
 */

import type { LibraryJSONSchema, Parser } from '@openuidev/lang-core';
import { createParser } from '@openuidev/lang-core';
import type { UiDiagnostic, UiDocument, UiStatement } from './document';
import { classify, emptyDocument, ROOT_REF, splitStatement } from './document';

//#region Statement scanner (line assembler)

const FENCE_PREFIX = '```';
const COMMENT_PREFIXES = [
  '#',
  '//',
];

interface ScannerState {
  buffer: string;
  depth: number;
  inString: boolean;
  escaped: boolean;
  line: number;
}

function freshScannerState(): ScannerState {
  return {
    buffer: '',
    depth: 0,
    inString: false,
    escaped: false,
    line: 0,
  };
}

interface ScannedLine {
  source: string;
  line: number;
}

/**
 * Consume raw text, returning each completed top-level statement line.
 * Newlines inside brackets or strings do not terminate a statement.
 */
function scanStatements(state: ScannerState, text: string): ScannedLine[] {
  const completed: ScannedLine[] = [];
  for (const ch of text) {
    if (ch === '\n' && state.depth <= 0 && !state.inString) {
      flushStatement(state, completed);
      continue;
    }
    state.buffer += ch;
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (ch === '\\') {
        state.escaped = true;
      } else if (ch === '"') {
        state.inString = false;
      }
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      state.depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      state.depth -= 1;
    }
  }
  return completed;
}

function flushStatement(state: ScannerState, out: ScannedLine[]): void {
  state.line += 1;
  const source = state.buffer.trim();
  state.buffer = '';
  state.depth = 0;
  state.inString = false;
  state.escaped = false;
  if (source.length === 0) {
    return;
  }
  out.push({
    source,
    line: state.line,
  });
}

//#endregion

//#region Statement acceptance

const BARE_SCHEMA: LibraryJSONSchema = {
  $defs: {},
};

/**
 * Structural gate: lang-core parses each completed statement before it is
 * admitted, so malformed source (unbalanced brackets, unterminated strings,
 * expression garbage) becomes a diagnostic instead of entering the document,
 * streaming to clients, or being serialized into surface recall. The schema is
 * empty on purpose: unknown-component errors are expected and ignored here,
 * because library validation is `validateDocument`'s job downstream.
 */
const structuralParser: Parser = createParser(BARE_SCHEMA);

function structuralDiagnostic(source: string, line: number): UiDiagnostic | null {
  try {
    const parsed = structuralParser.parse(source);
    if (parsed.meta.incomplete) {
      return {
        line,
        message: 'incomplete statement (unbalanced brackets or unterminated string)',
        source,
      };
    }
    if (parsed.meta.statementCount === 0) {
      return {
        line,
        message: 'not a parseable statement',
        source,
      };
    }
    return null;
  } catch (e) {
    return {
      line,
      message: e instanceof Error ? e.message : String(e),
      source,
    };
  }
}

/** Assemble one statement line into a `UiStatement`, or a diagnostic / skip. */
function acceptStatement(source: string, line: number): UiStatement | UiDiagnostic | null {
  if (source.startsWith(FENCE_PREFIX) || COMMENT_PREFIXES.some((p) => source.startsWith(p))) {
    return null;
  }
  const split = splitStatement(source);
  if (!split) {
    return {
      line,
      message: 'not an assignment statement',
      source,
    };
  }
  const malformed = structuralDiagnostic(source, line);
  if (malformed !== null) {
    return malformed;
  }
  return {
    ref: split.ref,
    kind: classify(split.ref, split.rhs),
    source,
    line,
  };
}

function isStatement(value: UiStatement | UiDiagnostic): value is UiStatement {
  return 'ref' in value;
}

//#endregion

//#region Incremental parser

/**
 * Streaming scanner: feed deltas with `push`, read completed statements as
 * they land, and `end()` to flush the trailing unterminated line and get the
 * document. Also usable one-shot via {@link parseDocument}.
 */
export class OpenUiLangParser {
  private readonly scanner = freshScannerState();
  private readonly doc: UiDocument;

  constructor(dialect?: string) {
    this.doc = emptyDocument(dialect);
  }

  /** Feed a text delta; returns statements completed by this chunk. */
  push(delta: string): UiStatement[] {
    return scanStatements(this.scanner, delta)
      .map(({ source, line }) => this.accept(source, line))
      .filter((s): s is UiStatement => s !== null);
  }

  /** Flush the trailing line and return the finished document. */
  end(): UiDocument {
    const completed: ScannedLine[] = [];
    flushStatement(this.scanner, completed);
    for (const { source, line } of completed) {
      this.accept(source, line);
    }
    return this.doc;
  }

  private accept(source: string, line: number): UiStatement | null {
    const parsed = acceptStatement(source, line);
    if (parsed === null) {
      return null;
    }
    if (!isStatement(parsed)) {
      this.doc.diagnostics.push(parsed);
      return null;
    }
    const existing = this.doc.statements[parsed.ref];
    this.doc.statements[parsed.ref] = parsed;
    if (existing !== undefined) {
      this.doc.order.splice(this.doc.order.indexOf(parsed.ref), 1);
    }
    this.doc.order.push(parsed.ref);
    if (parsed.ref === ROOT_REF) {
      this.doc.root = ROOT_REF;
    }
    return parsed;
  }
}

/** One-shot parse of a full turn's output into the statement-level document. */
export function parseDocument(text: string, dialect?: string): UiDocument {
  const parser = new OpenUiLangParser(dialect);
  parser.push(text);
  return parser.end();
}

//#endregion
