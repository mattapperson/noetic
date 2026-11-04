/**
 * The most of the turn's connections a document node with no `tools` may be
 * offered (spec 26 § Tools): the connections the host's allowlist grants, with
 * exactly their granted operations, and the MCP servers the document attaches.
 * The hydrator records it on the step it builds for the node. Unlike a `tools`
 * list, it narrows only connection tools: the node keeps every other tool a
 * step with no `tools` is offered.
 */

import type { ConnectionPick, Step } from '@noetic-tools/types';

const CEILINGS = new WeakMap<object, ReadonlyArray<ConnectionPick>>();

/** Records `picks` as the most of the turn's connections `step` may be offered. */
export function setConnectionCeiling(step: object, picks: ReadonlyArray<ConnectionPick>): void {
  CEILINGS.set(step, picks);
}

/** The ceiling recorded on `step`, when a document node built it. */
export function connectionCeilingOf(
  step: Step | object,
): ReadonlyArray<ConnectionPick> | undefined {
  return CEILINGS.get(step);
}
