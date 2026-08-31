/**
 * Typed fragment builder for tool-authored UI.
 *
 * `fragment(library)` compiles a constructor per registered component from the
 * library's own Zod prop schemas, so tool render functions build fragments in
 * plain TypeScript and get validation at construction time — a typo'd
 * component name fails typecheck, a bad literal prop fails before the client
 * renderer ever sees it. Constructors return a `UiFragment` (dialect + OpenUI
 * Lang source) that also composes as a child of other constructors.
 */

import type { UiFragment } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { OPENUI_LANG_DIALECT } from './lang/document';
import type { UiLibrary } from './library';
import { componentProps } from './library';

//#region Fragment expression values

const FRAGMENT_EXPR: unique symbol = Symbol.for('noetic.openui.fragment-expr');

/** @public A composable fragment node: a `UiFragment` that also nests as a child argument. */
export interface FragmentNode extends UiFragment {
  /** Serialized OpenUI Lang expression source for this node (no `root =` wrapper). */
  [FRAGMENT_EXPR]: string;
}

/** @public Any value accepted as a fragment constructor argument. */
export type FragmentArg =
  | string
  | number
  | boolean
  | null
  | FragmentNode
  | FragmentArg[]
  | {
      [key: string]: FragmentArg;
    };

function isFragmentNode(value: unknown): value is FragmentNode {
  return typeof value === 'object' && value !== null && FRAGMENT_EXPR in value;
}

/** Serialize a constructor argument to OpenUI Lang expression source. */
function serializeArg(arg: FragmentArg): string {
  if (isFragmentNode(arg)) {
    return arg[FRAGMENT_EXPR];
  }
  if (Array.isArray(arg)) {
    return `[${arg.map(serializeArg).join(', ')}]`;
  }
  if (typeof arg === 'object' && arg !== null) {
    return `{${Object.entries(arg)
      .map(([key, value]) => `${key}: ${serializeArg(value)}`)
      .join(', ')}}`;
  }
  return typeof arg === 'string' ? JSON.stringify(arg) : String(arg);
}

function makeNode(dialect: string, exprSource: string): FragmentNode {
  return {
    dialect,
    source: `root = ${exprSource}`,
    [FRAGMENT_EXPR]: exprSource,
  };
}

//#endregion

//#region Expression helpers

/** @public Reference another statement by ref (`uiRef('chart')` → `chart`). */
export function uiRef(name: string, dialect?: string): FragmentNode {
  return makeNode(dialect ?? OPENUI_LANG_DIALECT, name);
}

/** @public Reference a reactive state variable (`uiState('tab')` → `$tab`). */
export function uiState(name: string, dialect?: string): FragmentNode {
  return makeNode(dialect ?? OPENUI_LANG_DIALECT, `$${name}`);
}

/** @public A built-in function step (`uiBuiltin('Run', uiRef('save'))` → `@Run(save)`). */
export function uiBuiltin(fn: string, ...args: FragmentArg[]): FragmentNode {
  return makeNode(OPENUI_LANG_DIALECT, `@${fn}(${args.map(serializeArg).join(', ')})`);
}

//#endregion

//#region Builder

/** @public One constructor per component: builds a validated fragment node. */
export type FragmentBuilder<N extends string> = Record<N, (...args: FragmentArg[]) => FragmentNode>;

/**
 * Compile a typed fragment builder from a library.
 * @public
 */
export function fragment<N extends string>(library: UiLibrary<N>): FragmentBuilder<N> {
  const builder: Record<string, (...args: FragmentArg[]) => FragmentNode> = {};
  for (const def of library.components.values()) {
    const props = componentProps(def);
    builder[def.name] = (...args: FragmentArg[]): FragmentNode => {
      if (args.length > props.length) {
        throw new Error(
          `${def.name}() takes at most ${props.length} argument(s) (${props.map((p) => p.name).join(', ')}), got ${args.length}`,
        );
      }
      args.forEach((arg, i) => {
        const prop = props[i];
        // Only literal primitives are statically checkable; refs/state/nested
        // calls (FragmentNodes) and object/array args resolve at render time.
        if (
          prop &&
          (typeof arg === 'string' ||
            typeof arg === 'number' ||
            typeof arg === 'boolean' ||
            arg === null)
        ) {
          const parsed = z.safeParse(prop.schema, arg);
          if (!parsed.success) {
            throw new Error(
              `${def.name}() prop '${prop.name}' rejects ${JSON.stringify(arg)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
            );
          }
        }
      });
      return makeNode(library.dialect, `${def.name}(${args.map(serializeArg).join(', ')})`);
    };
  }
  // Keys are exactly the library's component names; TS can't see that through
  // the Map iteration, so bridge with the framework's approved cast.
  return frameworkCast<FragmentBuilder<N>>(builder);
}

//#endregion
