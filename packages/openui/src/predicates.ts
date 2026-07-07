/**
 * Loop termination predicates over the UI surface. `Until` predicates receive
 * only a `Snapshot`, so each predicate closes over the surface layer instance
 * and reads its live state mirror — making the interaction loop plain
 * composition: `loop({ body, until: ui.submitted(surface, 'checkout-form') })`.
 */

import type { Snapshot, Verdict } from '@noetic-tools/types';
import type { OpenUiInteraction, OpenUiSurfaceLayer, UiEventKind } from './layer/surface';

/**
 * A synchronous `Until`. Assignable to `Until` (which permits a sync `Verdict`),
 * so it works directly as a loop `until`, and its result is directly inspectable
 * without awaiting.
 * @public
 */
export type SyncUntil = (snapshot: Snapshot) => Verdict;

function interactionsOf(surface: OpenUiSurfaceLayer): OpenUiInteraction[] {
  return surface.readState()?.interactions ?? [];
}

/**
 * Namespace of UI-surface loop termination predicates.
 * @public
 */
export const ui = {
  /**
   * Stops when a `submit` interaction has landed on the surface — for `ref`
   * when given, otherwise any submit.
   */
  submitted(surface: OpenUiSurfaceLayer, ref?: string): SyncUntil {
    return (_snap: Snapshot): Verdict => {
      const hit = interactionsOf(surface).find(
        (i) => i.kind === 'submit' && (ref === undefined || i.ref === ref),
      );
      return {
        stop: hit !== undefined,
        reason: hit ? `UI submit on '${hit.ref}'` : undefined,
      };
    };
  },

  /** Stops on any terminal interaction — optionally narrowed by kind. */
  interacted(surface: OpenUiSurfaceLayer, kind?: Exclude<UiEventKind, 'set'>): SyncUntil {
    return (_snap: Snapshot): Verdict => {
      const hit = interactionsOf(surface).find((i) => kind === undefined || i.kind === kind);
      return {
        stop: hit !== undefined,
        reason: hit ? `UI interaction '${hit.kind}' on '${hit.ref}'` : undefined,
      };
    };
  },

  /** Stops when the client sent an `@ToAssistant(...)` message. */
  toAssistant(surface: OpenUiSurfaceLayer): SyncUntil {
    return (_snap: Snapshot): Verdict => {
      const hit = interactionsOf(surface).find((i) => i.kind === 'toAssistant');
      return {
        stop: hit !== undefined,
        reason: hit ? `UI message to assistant from '${hit.ref}'` : undefined,
      };
    };
  },
};
