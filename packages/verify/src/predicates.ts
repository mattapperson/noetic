/**
 * Predicates: lowering a matcher to an OVP predicate, and evaluating
 * predicates three-valued over a window's observations.
 *
 * A matcher with no wildcard lowers to OVP's own `present`/`count`/`measure`
 * predicate, which OVP's `evaluate()` decides. A matcher with a wildcard, a
 * status class, a value check or an event type lowers to a Noetic
 * implementation predicate (`x-noetic-*`, OVP §4 allows this) that still names
 * its sense and that only this package evaluates; anyone else reads it as
 * "not evaluated", never as false (OVP-INTENT-5).
 */

import type { Coverage, Observation } from '@noetic-tools/types/verify';
import { evaluate, impeachingSpots } from 'open-verification';
import { z } from 'zod';
import { globToRegExp, tryCompileMatcher, valuesEqual } from './grammar';

//#region Types

/** A count bound in OVP's vocabulary. */
export interface CountBound {
  readonly op: 'exactly' | 'at-least' | 'at-most';
  readonly value: number;
}

/** What evaluation needs beyond the observations: the event type behind each one. */
export interface EvaluationContext {
  eventTypeOf(observation: Observation): string | undefined;
}

//#endregion

//#region Schemas

const CountBoundSchema = z.object({
  op: z.enum([
    'exactly',
    'at-least',
    'at-most',
  ]),
  value: z.number().int().nonnegative(),
});

/** A sense matcher evaluated by Noetic: a wildcard, a status class or a value check. */
const SelectPredicateSchema = z.object({
  kind: z.literal('x-noetic-select'),
  channel: z.string(),
  matcher: z.string(),
  count: CountBoundSchema.optional(),
  equals: z
    .union([
      z.number(),
      z.string(),
      z.boolean(),
    ])
    .optional(),
  tolerance: z.number().nonnegative().optional(),
});

/** An event type, on the channel the event's sense names. */
const EventPredicateSchema = z.object({
  kind: z.literal('x-noetic-event'),
  channel: z.string(),
  event: z.string(),
  count: CountBoundSchema.optional(),
});

/** A constraint: what `holds` describes must never all be true at once. */
const NeverPredicateSchema = z.object({
  kind: z.literal('x-noetic-never'),
  holds: z.array(z.unknown()).min(1),
});

/** @internal The Noetic implementation predicate a matcher lowered to. */
export type SelectPredicate = z.infer<typeof SelectPredicateSchema>;
/** @internal */
export type EventPredicate = z.infer<typeof EventPredicateSchema>;
/** @internal */
export type NeverPredicate = z.infer<typeof NeverPredicateSchema>;

//#endregion

//#region Helpers

function compareCount(found: number, bound: CountBound | undefined): boolean {
  if (bound === undefined) {
    return found > 0;
  }
  if (bound.op === 'exactly') {
    return found === bound.value;
  }
  if (bound.op === 'at-least') {
    return found >= bound.value;
  }
  return found <= bound.value;
}

function evaluateSelect(
  p: SelectPredicate,
  observations: readonly Observation[],
): boolean | undefined {
  const selection = tryCompileMatcher(p.channel, p.matcher);
  if (!selection) {
    return undefined;
  }
  const selected = observations.filter((o) => o.channel === p.channel && selection.test(o));
  if (p.equals === undefined) {
    return compareCount(selected.length, p.count);
  }
  const withValue = selected.filter((o) => o.value !== undefined);
  if (withValue.length === 0) {
    return undefined;
  }
  const expected = p.equals;
  const matching = withValue.filter((o) => valuesEqual(o.value, expected, p.tolerance ?? 0));
  return compareCount(matching.length, p.count);
}

function evaluateEvent(
  p: EventPredicate,
  observations: readonly Observation[],
  ctx: EvaluationContext,
): boolean {
  const re = globToRegExp(p.event, false);
  const found = observations.filter((o) => {
    const type = ctx.eventTypeOf(o);
    return type !== undefined && re.test(type);
  });
  return compareCount(found.length, p.count);
}

function evaluateNever(
  p: NeverPredicate,
  observations: readonly Observation[],
  ctx: EvaluationContext,
): boolean | undefined {
  const answers = p.holds.map((h) => evaluatePredicate(h, observations, ctx));
  if (answers.some((a) => a === false)) {
    return true;
  }
  if (answers.some((a) => a === undefined)) {
    return undefined;
  }
  return false;
}

//#endregion

//#region Public API

/**
 * Whether `predicate` counts events — something a read before the action can
 * never show, so the before-check leaves it `undefined` (OVP-INTENT-5).
 */
export function isEventPredicate(predicate: unknown): boolean {
  return EventPredicateSchema.safeParse(predicate).success;
}

/**
 * Evaluates one predicate, three-valued: `undefined` means nothing could
 * evaluate it. OVP's own kinds go to OVP's `evaluate()`.
 */
export function evaluatePredicate(
  predicate: unknown,
  observations: readonly Observation[],
  ctx: EvaluationContext,
): boolean | undefined {
  const select = SelectPredicateSchema.safeParse(predicate);
  if (select.success) {
    return evaluateSelect(select.data, observations);
  }
  const eventPredicate = EventPredicateSchema.safeParse(predicate);
  if (eventPredicate.success) {
    return evaluateEvent(eventPredicate.data, observations, ctx);
  }
  const never = NeverPredicateSchema.safeParse(predicate);
  if (never.success) {
    return evaluateNever(never.data, observations, ctx);
  }
  return evaluate(predicate, observations);
}

/**
 * Whether a claim's assertions held, given what could not be seen — OVP's
 * `assertionsHeldUnder` with Noetic's predicates understood. `undefined` when
 * a gap falls on a sense the claim reads, or nothing could evaluate it.
 */
export function assertionsHeldUnder(opts: {
  assertions: ReadonlyArray<{
    readonly predicate?: unknown;
    readonly channels: readonly string[];
  }>;
  observations: readonly Observation[];
  coverage: Coverage;
  ctx: EvaluationContext;
}): boolean | undefined {
  const { assertions, observations, coverage, ctx } = opts;
  const channelsRead = [
    ...new Set(assertions.flatMap((a) => a.channels)),
  ];
  if (impeachingSpots(coverage, channelsRead).length > 0) {
    return undefined;
  }
  return assertionsHeld(assertions, observations, ctx);
}

/** Whether a claim's assertions held over these observations; `undefined` when none could be evaluated. */
export function assertionsHeld(
  assertions: ReadonlyArray<{
    readonly predicate?: unknown;
  }>,
  observations: readonly Observation[],
  ctx: EvaluationContext,
): boolean | undefined {
  const answers = assertions
    .map((a) => evaluatePredicate(a.predicate, observations, ctx))
    .filter((v): v is boolean => v !== undefined);
  if (answers.length === 0) {
    return undefined;
  }
  return answers.every((v) => v);
}

//#endregion
