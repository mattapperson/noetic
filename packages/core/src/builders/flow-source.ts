/**
 * A flow that is data: a step tree built from a JSON source by a function that
 * can build it again. A harness stores such a source with each turn, and resumes
 * the turn on the flow it began under (spec 23 § Stored flows). The JSON workflow
 * builders are its only callers; a host has no way to name a source of its own.
 */

import { frameworkCast } from '@noetic-tools/types';

//#region Types

/** A step, as far as naming its source needs to know one. */
interface StepLike {
  readonly kind: string;
  readonly id: string;
}

/** @internal What a step was built from, and what builds a step from the like. */
export interface FlowSource {
  /** JSON-serialisable. It names the flow's version and is what a session stores. */
  readonly source: unknown;
  /** Builds a step from a source, the one in hand or one read back from storage. */
  build(source: unknown): StepLike;
}

//#endregion

//#region Public API

/**
 * @internal
 * Builds a step from `source` and remembers both, so a harness given the step as
 * its `agentGraph` can store the source with each turn and build the same flow
 * again for a turn that began under it.
 *
 * `source` is plain JSON, with no secret values in it: it is written to storage as
 * it is. `build` is code: a turn resumed on a stored source runs the tools, agents
 * and connections `build` closes over now. A source read back from storage is
 * whatever an earlier release wrote, so `build` checks it and throws when it
 * cannot build from it; the turn then moves to the harness's own flow.
 *
 * @returns `build(source)`.
 */
export function flowFrom<S, T extends StepLike>(source: S, build: (source: S) => T): T {
  const step = build(source);
  flowSources.set(step, {
    source,
    // A stored source is checked by `build`, not by its type.
    build: (stored) => build(frameworkCast<S>(stored)),
  });
  return step;
}

/** @internal The source `step` was built from, when it came from `flowFrom`. */
export function flowSourceOf(step: object): FlowSource | undefined {
  return flowSources.get(step);
}

//#endregion

//#region Helpers

const flowSources = new WeakMap<object, FlowSource>();

//#endregion
