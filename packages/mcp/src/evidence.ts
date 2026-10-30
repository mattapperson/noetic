/**
 * The optional evidence parts a profiled server provides for verification
 * (spec 36 § Parts every server provides): OVP blind spots from
 * `noetic://coverage?since=<cursor>` (each naming its sense, OVP-EVID-2) and
 * OVP anomalies from `noetic.detect({ since })` (with their tier,
 * OVP-REALITY-3). Values are validated before they reach the verifier.
 */

import type { Anomaly, BlindSpot } from '@noetic-tools/types/verify';
import { z } from 'zod';
import { COVERAGE_URI } from './wire';

//#region Schemas

const BlindSpotSchema = z.looseObject({
  kind: z.enum([
    'channel-unobserved',
    'boundary-uncrossable',
    'buffer-truncated',
    'redacted',
    'still-in-flight',
    'effect-elsewhere',
  ]),
  sense: z.string().optional(),
  channel: z.string().optional(),
  detail: z.string(),
  impeaching: z.boolean(),
  remedy: z.string().optional(),
});

const CoverageSchema = z.union([
  z.array(BlindSpotSchema),
  z.looseObject({
    blindSpots: z.array(BlindSpotSchema),
  }),
]);

const AnomalySchema = z.object({
  kind: z.string().min(1),
  tier: z.enum([
    'observed',
    'absence-derived',
    'advisory',
  ]),
  claim: z.string(),
  counter: z.string(),
  between: z.tuple([
    z.string(),
    z.string(),
  ]),
  evidence: z.array(z.string()),
});

const DetectSchema = z.union([
  z.array(AnomalySchema),
  z.looseObject({
    anomalies: z.array(AnomalySchema),
  }),
]);

//#endregion

//#region Public API

/** @public The coverage URI for a cursor. */
export function coverageUri(since: string | null): string {
  return since === null ? COVERAGE_URI : `${COVERAGE_URI}?since=${encodeURIComponent(since)}`;
}

/**
 * @public
 * Parses coverage content into OVP blind spots; a blind spot's sense is
 * carried as its `channel`.
 * @returns The blind spots, or `undefined` when the content is malformed.
 */
export function parseCoverage(value: unknown): BlindSpot[] | undefined {
  const parsed = CoverageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const spots = Array.isArray(parsed.data) ? parsed.data : parsed.data.blindSpots;
  return spots.map((spot) => {
    const channel = spot.sense ?? spot.channel;
    return {
      kind: spot.kind,
      detail: spot.detail,
      impeaching: spot.impeaching,
      ...(channel === undefined
        ? {}
        : {
            channel,
          }),
      ...(spot.remedy === undefined
        ? {}
        : {
            remedy: spot.remedy,
          }),
    };
  });
}

/**
 * @public
 * Parses `noetic.detect`'s output into OVP anomalies.
 * @returns The anomalies, or `undefined` when the output is malformed.
 */
export function parseAnomalies(value: unknown): Anomaly[] | undefined {
  const parsed = DetectSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.anomalies;
}

//#endregion
