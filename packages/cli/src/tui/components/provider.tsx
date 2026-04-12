import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { Theme } from './theme';
import { ThemeProvider } from './theme';

type KeyboardHandler = (event: unknown) => void;
type UseKeyboardHook = (handler: KeyboardHandler) => void;

const KeyboardContext = createContext<UseKeyboardHook | null>(null);

export interface InkProviderProps {
  /** Theme object. Defaults to darkTheme. */
  theme?: Theme;
  children: ReactNode;
}

export function InkProvider({ theme, children }: InkProviderProps) {
  const inner = (
    <KeyboardContext.Provider value={null}>{children}</KeyboardContext.Provider>
  );

  // Only wrap with ThemeProvider if a theme is explicitly provided
  if (theme) {
    return <ThemeProvider theme={theme}>{inner}</ThemeProvider>;
  }

  return inner;
}

/**
 * Returns the useKeyboard hook from context, or the prop override if provided.
 * Components should call this instead of using the prop directly.
 * Note: In Ink, components use useInput() directly instead of this context.
 */
export function useKeyboardContext(propOverride?: UseKeyboardHook): UseKeyboardHook | undefined {
  const fromContext = useContext(KeyboardContext);
  return propOverride ?? fromContext ?? undefined;
}
