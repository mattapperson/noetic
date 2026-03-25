/**
 * Gridland JSX type declarations.
 *
 * Gridland uses a custom React reconciler, not the DOM.
 * Augment React's element attribute interfaces to accept Gridland props.
 *
 * Source: https://github.com/thoughtfulllc/gridland/blob/main/examples/container-demo/gridland-jsx.d.ts
 */

import type { ReactNode } from 'react';

// biome CJS interop — permissive prop value that satisfies both Gridland and React
type GridlandPropValue =
  | string
  | number
  | boolean
  | undefined
  | null
  | ReactNode
  | Record<string, unknown>
  | ((...args: never[]) => void);

type GridlandElementProps = {
  children?: ReactNode;
  [key: string]: GridlandPropValue;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      box: GridlandElementProps;
      text: GridlandElementProps;
      input: GridlandElementProps;
      scrollbox: GridlandElementProps;
      code: GridlandElementProps;
      select: GridlandElementProps;
      'ascii-font': GridlandElementProps;
    }
  }
}
