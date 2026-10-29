/**
 * Zod mirrors of the OVP `Claim` and `Constraint` schemas
 * (`open-verification@1.1.0`), so a `verify` node can carry OVP documents and
 * the generated workflow JSON Schema inlines them rather than pointing at
 * another host. A test in `@noetic-tools/verify` checks these agree with the
 * package's own schemas.
 */

import { z } from 'zod';
import type { Claim, Constraint } from './ovp';

const OVP_CHANNEL_RE = /^x-[a-z0-9-]+$/;

/** @public Zod mirror of OVP's channel id: a named channel or an `x-` channel. */
export const OvpChannelIdSchema = z.union([
  z.enum([
    'ui',
    'net',
    'state',
    'signal',
    'log',
    'route',
    'storage',
    'time',
    'visual',
  ]),
  z.string().regex(OVP_CHANNEL_RE),
]);

/** @public Zod mirror of OVP's `AssertionSchema`. */
export const OvpAssertionSchema = z.object({
  id: z.string().min(1),
  predicate: z.unknown().optional(),
  reads: z.string().min(1),
  channels: z.array(OvpChannelIdSchema).min(1),
});

/** @public Zod mirror of OVP's `ClaimSchema`. */
export const OvpClaimSchema = z.object({
  id: z.string().min(1),
  intent: z.string().optional(),
  statement: z.string().min(1),
  declaredAt: z.enum([
    'before-action',
    'after-action',
  ]),
  assertions: z.array(OvpAssertionSchema).default([]),
}) satisfies z.ZodType<Claim, unknown>;

/** @public Zod mirror of OVP's `ConstraintSchema`. */
export const OvpConstraintSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  predicate: z.unknown().optional(),
  channels: z.array(OvpChannelIdSchema).min(1),
  severity: z
    .enum([
      'blocking',
      'advisory',
    ])
    .default('blocking'),
}) satisfies z.ZodType<Constraint, unknown>;
