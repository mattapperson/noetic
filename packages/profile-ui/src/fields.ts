/**
 * Field schemas the `ui@1` profile and the profiles extending it share: the
 * element target, the `within` scope, the accessibility tree, and the output
 * of an operation with effects.
 */

import type { Receipt, Ref } from '@noetic-tools/types';

import { profileFieldRegistry, RefSchema, receipt, ref, target } from '@noetic-tools/types';
import { z } from 'zod';

//#region Kinds

/** @public The ref kind of an element. Element refs are volatile. */
export const UI_ELEMENT_KIND = 'ui.element';

/**
 * @public
 * The ref kind a `within` scope is marked with. A scope is any ref the
 * connection handed out that contains elements — a tab, a window — so its
 * schema accepts a ref of any kind.
 */
export const UI_SCOPE_KIND = 'ui.scope';

//#endregion

//#region Field schemas

/** @public A volatile element ref, as `ui.find` and `ui.describe` hand out. */
export function elementRef(): z.ZodType<Ref<'ui.element'>, Ref<'ui.element'>> {
  return ref(UI_ELEMENT_KIND, {
    volatile: true,
  });
}

/** @public An element: its ref or a locator (`button "Pay"`) the server resolves to exactly one. */
export function elementTarget(): z.ZodType<Ref<'ui.element'> | string, Ref<'ui.element'> | string> {
  return target(UI_ELEMENT_KIND);
}

/** @public A `within` scope: a ref of any kind (a tab, a window), volatile. */
export function scopeRef(): z.ZodType<Ref, Ref> {
  const schema = z.union([
    RefSchema,
  ]);
  profileFieldRegistry.add(schema, {
    kind: 'ref',
    refKind: UI_SCOPE_KIND,
    volatile: true,
    public: false,
  });
  return schema;
}

/** @public The output of an operation with effects: `shape` plus its `receipt`. */
export function effectsOutput<const S extends z.ZodRawShape>(
  shape: S,
): z.ZodObject<
  S & {
    receipt: z.ZodType<Receipt, Receipt>;
  }
> {
  return z.object({
    ...shape,
    receipt: receipt(),
  });
}

//#endregion

//#region Accessibility tree

/** @public One node of the accessibility tree `ui.describe` and `ui.tree` return. */
export interface UiNode {
  readonly element: Ref<'ui.element'>;
  readonly role: string;
  readonly name: string;
  readonly text?: string;
  readonly value?: string;
  /** ARIA states and properties that hold: `focused`, `disabled`, `checked`, … */
  readonly states?: ReadonlyArray<string>;
  readonly children?: ReadonlyArray<UiNode>;
}

/** @public Zod schema for a `UiNode`. */
export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z.object({
    element: elementRef(),
    role: z.string().min(1),
    name: z.string(),
    text: z.string().optional(),
    value: z.string().optional(),
    states: z.array(z.string()).optional(),
    children: z.array(UiNodeSchema).optional(),
  }),
);

/** @public One element `ui.find` found. */
export const UiFoundElementSchema = z.object({
  element: elementRef(),
  role: z.string().min(1),
  name: z.string(),
  text: z.string().optional(),
});

//#endregion
