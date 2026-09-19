/**
 * The `openUi()` output codec: plugs a component library into `step.callModel`
 * as a streaming output dialect. Deltas feed the incremental scanner (emitting
 * `openui.*` framework events per completed statement); `finish()` reparses
 * the full text fresh so the returned document is deterministic whether or
 * not the turn actually streamed. The library prompt comes from
 * `@openuidev/lang-core`.
 */

import type { OutputCodec, OutputCodecEventEmitter, OutputCodecSession } from '@noetic-tools/types';
import type { UiDocument, UiStatement } from './lang/document';
import { UiStatementKind } from './lang/document';
import { OpenUiLangParser, parseDocument } from './lang/parser';
import type { UiLibrary } from './library';

/** Framework event types the codec emits as statements complete. */
export const OPENUI_EVENT = {
  Node: 'openui.node',
  State: 'openui.state',
  Query: 'openui.query',
  Fragment: 'openui.fragment',
} as const;

export type OpenUiEventType = (typeof OPENUI_EVENT)[keyof typeof OPENUI_EVENT];

function eventTypeFor(kind: UiStatementKind): OpenUiEventType {
  if (kind === UiStatementKind.State) {
    return OPENUI_EVENT.State;
  }
  if (kind === UiStatementKind.Query || kind === UiStatementKind.Mutation) {
    return OPENUI_EVENT.Query;
  }
  return OPENUI_EVENT.Node;
}

function emitStatement(statement: UiStatement, emit: OutputCodecEventEmitter): void {
  emit(eventTypeFor(statement.kind), {
    ref: statement.ref,
    kind: statement.kind,
    line: statement.line,
    source: statement.source,
  });
}

/**
 * Build the streaming output codec for a library. Use as `step.callModel`'s
 * `output`: the library prompt rides `instructions`, statements stream as
 * `openui.node` / `openui.state` / `openui.query` framework events, and the
 * step returns the materialized `UiDocument`.
 * @public
 */
export function openUi(library: UiLibrary): OutputCodec<UiDocument> {
  return {
    kind: 'codec',
    instructions: library.systemPrompt(),
    start(): OutputCodecSession<UiDocument> {
      const parser = new OpenUiLangParser(library.dialect);
      return {
        push(delta, emit) {
          for (const statement of parser.push(delta)) {
            emitStatement(statement, emit);
          }
        },
        finish(fullText) {
          return parseDocument(fullText, library.dialect);
        },
      };
    },
  };
}
