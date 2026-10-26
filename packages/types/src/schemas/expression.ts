/**
 * Zod schema for a JSON workflow expression (spec 33): a JSONata source
 * string. This package only checks the shape; `@noetic-tools/core` compiles
 * every expression when it validates a document, so `@noetic-tools/types`
 * stays free of the JSONata dependency.
 */

import { z } from 'zod';

/** @public A JSONata expression source string (spec 33). */
export type Expression = string;

/** @public Zod schema validating an `Expression`: a non-empty JSONata source string. */
export const ExpressionSchema: z.ZodType<Expression> = z.string().min(1).meta({
  id: 'Expression',
  title: 'Expression',
  description:
    'A JSONata expression (https://jsonata.org) evaluated against the node input, read as JSON when it parses.',
});
