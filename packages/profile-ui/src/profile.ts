/**
 * The `ui@1` profile (spec 36 § Catalog v1): acting on what an interface is.
 * The base of `browser`, `app` and `device`. Operations take an optional
 * `within` scope; `element` fields are targets — a ref or a locator.
 */

import { blob, defineProfile, receipt, SenseDefaults, sensitive } from '@noetic-tools/types';
import { z } from 'zod';
import {
  effectsOutput,
  elementRef,
  elementTarget,
  scopeRef,
  UiFoundElementSchema,
  UiNodeSchema,
} from './fields';

//#region Schemas

/** @public Modifier keys `ui.key` accepts. */
export const UiModifierSchema = z.enum([
  'alt',
  'ctrl',
  'meta',
  'shift',
]);

/** @public Directions `ui.scroll` accepts. */
export const UiDirectionSchema = z.enum([
  'up',
  'down',
  'left',
  'right',
]);

/** @public How a `ui.settle` window closed: OVP close conditions. */
export const UiClosedBySchema = z.enum([
  'quiescence',
  'signal',
  'budget-exhausted',
]);

function notBoth<
  T extends {
    readonly element?: object | string;
    readonly within?: object;
  },
>(value: T): boolean {
  return value.element === undefined || value.within === undefined;
}

const NOT_BOTH = {
  message: 'Give element or within, not both.',
};

const describeInput = z
  .object({
    element: elementTarget().optional(),
    within: scopeRef().optional(),
    full: z.boolean().optional(),
  })
  .refine(notBoth, NOT_BOTH);

const scrollInput = z
  .object({
    element: elementTarget().optional(),
    within: scopeRef().optional(),
    direction: UiDirectionSchema,
    amount: z.number().positive().optional(),
  })
  .refine(notBoth, NOT_BOTH);

const settleInput = z
  .object({
    until: z.enum([
      'quiet',
      'event',
    ]),
    event: z.string().min(1).optional(),
    quietMs: z.number().int().nonnegative().optional(),
    after: receipt().optional(),
    timeoutMs: z.number().int().positive(),
  })
  .refine((v) => (v.until === 'event') === (v.event !== undefined), {
    message: "Give event exactly when until is 'event'.",
    path: [
      'event',
    ],
  });

const textInput = z.object({
  element: elementTarget(),
  text: sensitive(z.string()),
});

/** @public What `ui.summary` reads: the focused element and counts by role. */
export const UiSummarySchema = z.object({
  focused: z
    .object({
      element: elementRef(),
      role: z.string(),
      name: z.string(),
    })
    .nullable(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

//#endregion

//#region Profile

/** @public The `ui@1` profile. */
export const ui = defineProfile({
  name: 'ui',
  version: '1.0.0',
  description: 'Acting on what an interface is: find, describe, tap, fill, settle.',
  operations: {
    'ui.find': {
      description: 'Find elements matching a query.',
      input: z.object({
        query: z.string().min(1),
        within: scopeRef().optional(),
      }),
      output: z.object({
        elements: z.array(UiFoundElementSchema),
      }),
      sense: 'ui',
      eager: true,
    },
    'ui.describe': {
      description:
        'The accessibility tree, with refs, of an element, a scope or the whole interface.',
      input: describeInput,
      output: z.object({
        tree: UiNodeSchema,
      }),
      sense: 'ui',
      eager: true,
    },
    'ui.tap': {
      description: 'Tap or click an element.',
      input: z.object({
        element: elementTarget(),
        count: z.number().int().positive().optional(),
      }),
      output: effectsOutput({}),
      effects: true,
      eager: true,
    },
    'ui.fill': {
      description: "Replace an element's value.",
      input: textInput,
      output: effectsOutput({}),
      effects: true,
      eager: true,
    },
    'ui.type': {
      description: "Append text to an element's value.",
      input: textInput,
      output: effectsOutput({}),
      effects: true,
    },
    'ui.key': {
      description: 'Press a key, optionally with modifiers, optionally on an element.',
      input: z.object({
        key: z.string().min(1),
        modifiers: z.array(UiModifierSchema).optional(),
        element: elementTarget().optional(),
      }),
      output: effectsOutput({}),
      effects: true,
    },
    'ui.scroll': {
      description: 'Scroll an element or a scope.',
      input: scrollInput,
      output: effectsOutput({}),
      effects: true,
    },
    'ui.select': {
      description: 'Select options of a list or menu.',
      input: z.object({
        element: elementTarget(),
        values: z.array(z.string()).min(1),
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'ui.check': {
      description: 'Check or uncheck a checkbox, switch or radio.',
      input: z.object({
        element: elementTarget(),
        checked: z.boolean(),
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'ui.hover': {
      description: 'Hover over an element.',
      input: z.object({
        element: elementTarget(),
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'ui.drag': {
      description: 'Drag an element onto another.',
      input: z.object({
        element: elementTarget(),
        to: elementTarget(),
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'ui.upload': {
      description: 'Give files to a file input.',
      input: z.object({
        element: elementTarget(),
        files: z
          .array(
            z.object({
              name: z.string().min(1),
              content: blob([]),
            }),
          )
          .min(1),
      }),
      output: effectsOutput({}),
      effects: true,
      required: false,
    },
    'ui.settle': {
      description: 'Wait until the interface is quiet or an event arrives, within a timeout.',
      input: settleInput,
      output: z.object({
        closedBy: UiClosedBySchema,
        unmeasurable: z.boolean().optional(),
      }),
      sense: 'time',
      eager: true,
    },
  },
  reads: {
    'ui.summary': {
      description: 'The focused element and counts.',
      schema: UiSummarySchema,
      sense: 'ui',
      look: 'turn',
    },
    'ui.tree': {
      description: 'The full accessibility tree.',
      schema: UiNodeSchema,
      sense: 'ui',
      look: 'effect',
    },
  },
  events: {
    'ui.changed': {
      description: 'The interface changed.',
      payload: z.object({
        within: scopeRef().optional(),
        summary: z.string().optional(),
      }),
      arguments: z.object({
        within: scopeRef().optional(),
      }),
      sense: 'ui',
      replay: 'live',
      required: false,
    },
  },
  senses: {
    ui: SenseDefaults.ui,
    time: SenseDefaults.time,
  },
});

//#endregion
