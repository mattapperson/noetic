/**
 * Tool-authored UI fragment emission.
 *
 * When a tool declares a `ui` block (`ToolUiDeclaration`), the runtime runs its
 * render functions at the call / progress / result / error lifecycle points and
 * forwards each returned `UiFragment` as an `openui.fragment` framework event
 * (namespaced `${agentName}:openui.fragment`). The framework never interprets
 * the fragment source — a UI surface (memory layer + transport) composes it.
 *
 * The `ui` methods are declared bivariantly on `ToolUiDeclaration`, so the
 * erased `Tool` handle the runtime holds can call them with runtime values.
 */

import type { Context, Tool, UiFragment } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { emitFrameworkEvent, getBroadcaster } from './broadcaster-utils';

const OPENUI_FRAGMENT_EVENT = 'openui.fragment';

/** The tool-UI lifecycle point being rendered. */
export type ToolUiPhase = 'call' | 'progress' | 'result' | 'error';

/** Parameters for {@link emitToolUi}. */
export interface EmitToolUiParams {
  ctx: Context;
  tool: Tool;
  callId: string;
  phase: ToolUiPhase;
  /** Parsed tool args (partial at `call` time). */
  args: unknown;
  /** Events seen so far — for `progress`. */
  events?: unknown[];
  /** The tool's return value — for `result`. */
  output?: unknown;
  /** The thrown error — for `error`. */
  error?: unknown;
}

function renderFragment(params: EmitToolUiParams): UiFragment | null {
  const ui = params.tool.ui;
  if (!ui) {
    return null;
  }
  // The `ui` methods are typed against the tool's own I/O schemas, erased to
  // `ZodTypeAny` on the `Tool` handle the runtime holds. frameworkCast bridges
  // the runtime values (`unknown`) to those erased parameter types.
  const args = frameworkCast<never>(params.args);
  const output = frameworkCast<never>(params.output);
  switch (params.phase) {
    case 'call':
      return ui.call ? ui.call(args) : null;
    case 'progress':
      return ui.progress ? ui.progress(params.events ?? []) : null;
    case 'result':
      return ui.result ? ui.result(output, args) : null;
    case 'error':
      return ui.error ? ui.error(params.error, args) : null;
  }
}

/**
 * Render the tool's UI fragment for one lifecycle phase and, when it produces
 * one, emit it as an `openui.fragment` framework event. No-op when the tool
 * declares no `ui` for that phase.
 */
export function emitToolUi(params: EmitToolUiParams): void {
  const fragment = renderFragment(params);
  if (fragment === null) {
    return;
  }
  emitFrameworkEvent({
    broadcaster: getBroadcaster(params.ctx),
    agentName: params.ctx.harness.config.name,
    eventType: OPENUI_FRAGMENT_EVENT,
    data: {
      callId: params.callId,
      dialect: fragment.dialect,
      source: fragment.source,
    },
  });
}
