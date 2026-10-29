/**
 * Matcher builders for `expect` and `never` (spec 37 § Writing a verify):
 * `net('POST /api/orders 201').once()`, `state('cart.total').equals(42, { tolerance: 0.5 })`,
 * `event('device.app.crashed')`.
 */

import type { SenseId } from '@noetic-tools/types';
import { SenseIdSchema } from '@noetic-tools/types';
import type { VerifyCount, VerifyMatcher } from '@noetic-tools/types/verify';
import { z } from 'zod';
import { verifyInvalid } from './errors';

//#region Types

/** A sense matcher as plain data. */
export type SenseVerifyMatcher = Extract<
  VerifyMatcher,
  {
    kind: 'sense';
  }
>;

/** An event matcher as plain data. */
export type EventVerifyMatcher = Extract<
  VerifyMatcher,
  {
    kind: 'event';
  }
>;

/** Count methods every builder has. Each returns a new builder. */
export interface CountMethods<B> {
  /** Exactly one. */
  once(): B;
  /** Exactly `n`. */
  count(n: number): B;
  /** At least `n`. */
  atLeast(n: number): B;
  /** At most `n`. */
  atMost(n: number): B;
}

/**
 * @public
 * A matcher on a sense. Pass it in `expect` or `never`; `matcher` holds the
 * plain `VerifyMatcher` it stands for.
 */
export interface SenseMatcherBuilder extends CountMethods<SenseMatcherBuilder> {
  readonly matcher: SenseVerifyMatcher;
  /** A measured value (OVP `measure`, or value equality for strings and booleans). */
  equals(
    value: number | string | boolean,
    options?: {
      tolerance?: number;
    },
  ): SenseMatcherBuilder;
}

/** @public A matcher on an event type. */
export interface EventMatcherBuilder extends CountMethods<EventMatcherBuilder> {
  readonly matcher: EventVerifyMatcher;
}

/** @public Anything `expect` and `never` accept: a builder or a plain matcher. */
export type VerifyMatcherInput = VerifyMatcher | SenseMatcherBuilder | EventMatcherBuilder;

//#endregion

//#region Schemas

const BoundSchema = z.number().int().nonnegative().optional();

/** Validates a plain matcher, from a builder or written by hand. */
const VerifyMatcherSchema = z.union([
  z.object({
    kind: z.literal('sense'),
    sense: SenseIdSchema,
    match: z.string(),
    equals: z
      .union([
        z.number(),
        z.string(),
        z.boolean(),
      ])
      .optional(),
    tolerance: z.number().nonnegative().finite().optional(),
    count: BoundSchema,
    atLeast: BoundSchema,
    atMost: BoundSchema,
  }),
  z.object({
    kind: z.literal('event'),
    event: z.string().min(1),
    count: BoundSchema,
    atLeast: BoundSchema,
    atMost: BoundSchema,
  }),
]);

//#endregion

//#region Helpers

function checkBound(name: string, n: number): void {
  if (Number.isInteger(n) && n >= 0) {
    return;
  }
  throw verifyInvalid(
    `Matcher bound ${name}(${String(n)}) must be a non-negative integer.`,
    `Pass a whole number to ${name}(), e.g. ${name}(1).`,
  );
}

function withCount<M extends VerifyMatcher>(matcher: M, bounds: VerifyCount): M {
  const merged: VerifyCount = {
    count: bounds.count ?? matcher.count,
    atLeast: bounds.atLeast ?? matcher.atLeast,
    atMost: bounds.atMost ?? matcher.atMost,
  };
  if (merged.count !== undefined && (merged.atLeast !== undefined || merged.atMost !== undefined)) {
    throw verifyInvalid(
      'A matcher cannot combine an exact count with atLeast or atMost.',
      'Use .count(n) or .once() alone, or bound it with .atLeast(n) and .atMost(n).',
    );
  }
  return {
    ...matcher,
    ...(merged.count === undefined
      ? {}
      : {
          count: merged.count,
        }),
    ...(merged.atLeast === undefined
      ? {}
      : {
          atLeast: merged.atLeast,
        }),
    ...(merged.atMost === undefined
      ? {}
      : {
          atMost: merged.atMost,
        }),
  };
}

function countMethods<M extends VerifyMatcher, B>(matcher: M, wrap: (m: M) => B): CountMethods<B> {
  return {
    once: () =>
      wrap(
        withCount(matcher, {
          count: 1,
        }),
      ),
    count: (n) => {
      checkBound('count', n);
      return wrap(
        withCount(matcher, {
          count: n,
        }),
      );
    },
    atLeast: (n) => {
      checkBound('atLeast', n);
      return wrap(
        withCount(matcher, {
          atLeast: n,
        }),
      );
    },
    atMost: (n) => {
      checkBound('atMost', n);
      return wrap(
        withCount(matcher, {
          atMost: n,
        }),
      );
    },
  };
}

function senseBuilder(matcher: SenseVerifyMatcher): SenseMatcherBuilder {
  return {
    matcher,
    ...countMethods(matcher, senseBuilder),
    equals: (value, options) => {
      const tolerance = options?.tolerance;
      if (tolerance !== undefined && !(Number.isFinite(tolerance) && tolerance >= 0)) {
        throw verifyInvalid(
          `Matcher tolerance ${String(tolerance)} must be a finite, non-negative number.`,
        );
      }
      return senseBuilder({
        ...matcher,
        equals: value,
        ...(tolerance === undefined
          ? {}
          : {
              tolerance,
            }),
      });
    },
  };
}

function eventBuilder(matcher: EventVerifyMatcher): EventMatcherBuilder {
  return {
    matcher,
    ...countMethods(matcher, eventBuilder),
  };
}

//#endregion

//#region Public API

/**
 * @public
 * A matcher on any sense, `x-` senses included: `sense('x-orders-db', 'orders.count').once()`.
 */
export function sense(id: SenseId, match: string): SenseMatcherBuilder {
  return senseBuilder({
    kind: 'sense',
    sense: id,
    match,
  });
}

/** @public Requests and responses: `net('POST /api/orders 201')`, `net('5xx')`. */
export function net(match: string): SenseMatcherBuilder {
  return sense('net', match);
}

/** @public What is on screen: `ui('heading "Order confirmed"')`. */
export function ui(match: string): SenseMatcherBuilder {
  return sense('ui', match);
}

/** @public Errors and messages: `log('error "TypeError"')`. */
export function log(match: string): SenseMatcherBuilder {
  return sense('log', match);
}

/** @public Where the user is: `route('/checkout/done')`. */
export function route(match: string): SenseMatcherBuilder {
  return sense('route', match);
}

/** @public Application state: `state('cart.total').equals(42, { tolerance: 0.5 })`. */
export function state(match: string): SenseMatcherBuilder {
  return sense('state', match);
}

/** @public Events the application announces: `signal('order.placed')`. */
export function signal(match: string): SenseMatcherBuilder {
  return sense('signal', match);
}

/** @public An event of a type: `event('device.app.crashed')`. */
export function event(type: string): EventMatcherBuilder {
  return eventBuilder({
    kind: 'event',
    event: type,
  });
}

/**
 * @public
 * The plain `VerifyMatcher` an `expect`/`never` entry stands for, validated.
 * @throws NoeticConfigError `VERIFY_INVALID` when the entry is not a matcher.
 */
export function toVerifyMatcher(input: VerifyMatcherInput): VerifyMatcher {
  const raw = 'matcher' in input ? input.matcher : input;
  const parsed = VerifyMatcherSchema.safeParse(raw);
  if (!parsed.success) {
    throw verifyInvalid(
      `Not a verify matcher: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
      "Build matchers with net(), ui(), log(), route(), state(), signal(), sense() or event(), or write { kind: 'sense', sense, match }.",
    );
  }
  const matcher = parsed.data;
  if (
    matcher.count !== undefined &&
    (matcher.atLeast !== undefined || matcher.atMost !== undefined)
  ) {
    throw verifyInvalid('A matcher cannot combine an exact count with atLeast or atMost.');
  }
  return matcher;
}

//#endregion
