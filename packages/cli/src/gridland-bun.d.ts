/**
 * Supplemental type declarations for @gridland/bun.
 *
 * The published .d.ts only covers native/engine exports.
 * These declarations augment the module with React component and reconciler
 * exports that are bundled monolithically in dist/index.js.
 */

import type { ReactNode } from 'react';

declare module '@gridland/bun' {
  // Reconciler
  export function createRoot(renderer: CliRenderer): {
    render(element: ReactNode): void;
  };

  // JSX Components
  export function Box(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;
  export function Text(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;
  export function ScrollBox(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;
  export function Input(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;
  export function Code(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;
  export function Select(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;
  export function TabSelect(props: Record<string, unknown>, ...children: ReactNode[]): ReactNode;

  // Hooks (from @gridland/utils)
  export function useKeyboard(): unknown;
  export function useTerminalDimensions(): {
    width: number;
    height: number;
  };
  export function useOnResize(callback: () => void): void;
  export function useRenderer(): CliRenderer;
  export function useAppContext(): unknown;
}
