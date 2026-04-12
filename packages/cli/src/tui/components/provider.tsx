import type { ReactNode } from 'react';
import type { Theme } from './theme';
import { ThemeProvider } from './theme';

export interface InkProviderProps {
  /** Theme object. Defaults to darkTheme. */
  theme?: Theme;
  children: ReactNode;
}

/**
 * Root provider for Ink-based TUI components.
 *
 * In Ink, keyboard handling is done via the `useInput()` hook from the `ink` package
 * directly in components, so no keyboard context is needed here.
 */
export function InkProvider({ theme, children }: InkProviderProps) {
  if (theme) {
    return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
  }
  return <>{children}</>;
}

/** @deprecated Use InkProvider instead. Will be removed in a future version. */
export const GridlandProvider = InkProvider;

/** @deprecated Props type alias for GridlandProvider. Use InkProviderProps instead. */
export type GridlandProviderProps = InkProviderProps;
