/**
 * The `screen@1` profile (spec 36 § Catalog v1): pixels. For surfaces with no
 * structure (games, canvases, remote desktops), and as an optional companion
 * to `ui@1`. Coordinates are pixels of the capture whose `frame` they carry;
 * a server refuses a frame that no longer matches the screen with
 * `stale_reference` instead of tapping something that moved.
 */

import type { Ref } from '@noetic-tools/types';

import {
  blob,
  defineProfile,
  profileFieldRegistry,
  RefSchema,
  receipt,
  ref,
  SenseDefaults,
} from '@noetic-tools/types';
import { z } from 'zod';

//#region Field schemas

/** @public The ref kind of a capture. Frame refs are volatile. */
export const SCREEN_FRAME_KIND = 'screen.frame';

/** @public The summary of every `visual` observation (spec 36 § Senses). The sense has no matcher. */
export const VISUAL_SUMMARY = 'capture';

/** @public Writes a `visual` summary: always `capture`. */
export function formatVisualSummary(): string {
  return VISUAL_SUMMARY;
}

function frameRef(): ReturnType<typeof ref<'screen.frame'>> {
  return ref(SCREEN_FRAME_KIND, {
    volatile: true,
  });
}

/** A `within` scope: any ref (a window), marked as `ui.scope` as `ui@1` marks it. */
function scopeRef(): z.ZodType<Ref, Ref> {
  const schema = z.union([
    RefSchema,
  ]);
  profileFieldRegistry.add(schema, {
    kind: 'ref',
    refKind: 'ui.scope',
    volatile: true,
    public: false,
  });
  return schema;
}

const pixel = z.number().int().nonnegative();

const tapOutput = z.object({
  receipt: receipt(),
});

//#endregion

//#region Schemas

/** @public A rectangle in screen pixels. */
export const ScreenRegionSchema = z.object({
  x: pixel,
  y: pixel,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** @public A capture: `screen.capture`'s output and `screen.current`'s value. */
export const ScreenCaptureSchema = z.object({
  frame: frameRef(),
  image: blob([
    'image/*',
  ]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

//#endregion

//#region Profile

/** @public The `screen@1` profile. */
export const screen = defineProfile({
  name: 'screen',
  version: '1.0.0',
  description: 'Pixels: capture the screen, tap and drag by coordinates.',
  determinism: {
    reset: 'none',
    replayPrefix: 'unsafe',
    time: 'wall',
    observation: 'sampled',
    actions: 'reversible',
  },
  operations: {
    'screen.capture': {
      description: 'Capture the screen, a scope or a region.',
      input: z.object({
        within: scopeRef().optional(),
        region: ScreenRegionSchema.optional(),
      }),
      output: ScreenCaptureSchema,
      sense: 'visual',
    },
    'screen.tap': {
      description: 'Tap at pixel coordinates of a capture.',
      input: z.object({
        frame: frameRef(),
        x: pixel,
        y: pixel,
        count: z.number().int().positive().optional(),
      }),
      output: tapOutput,
      effects: true,
    },
    'screen.drag': {
      description: 'Drag along a path of pixel coordinates of a capture.',
      input: z.object({
        frame: frameRef(),
        path: z
          .array(
            z.object({
              x: pixel,
              y: pixel,
              dtMs: z.number().nonnegative().optional(),
            }),
          )
          .min(2),
      }),
      output: tapOutput,
      effects: true,
      required: false,
    },
  },
  reads: {
    'screen.current': {
      description: 'A capture of the screen as it is now.',
      schema: ScreenCaptureSchema,
      sense: 'visual',
      look: 'ask',
    },
  },
  senses: {
    visual: SenseDefaults.visual,
  },
});

//#endregion
