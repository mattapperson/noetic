/** Shared client types — kept separate so components.tsx and render.tsx don't cycle. */

import type { ReactNode } from 'react';

/** What the renderer hands to a component: resolved props + interaction hooks. */
export interface RenderContext {
  vars: Record<string, unknown>;
  /** Fire a follow-up agent turn (the path @ToAssistant interactions take). */
  onIntent: (message: string) => void;
  /** Mirror a `$var` edit locally so inputs stay responsive between turns. */
  onSet: (name: string, value: unknown) => void;
}

/**
 * A registered client component: the ordered prop names (mirroring the server
 * library's declaration order, since OpenUI Lang args are positional) and a
 * render function.
 */
export interface ComponentSpec {
  props: readonly string[];
  render: (props: Record<string, unknown>, ctx: RenderContext, key: string) => ReactNode;
}
