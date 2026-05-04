/**
 * React context that exposes live session state to plugin-contributed footer
 * components (see `NoeticPlugin.footer`). Keeps the plugin API prop-free so we
 * can extend `FooterContext` without breaking plugins.
 */

import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import type { FooterContext } from '../plugins/types.js';

const FooterReactContext = createContext<FooterContext | null>(null);

export function FooterContextProvider({
  value,
  children,
}: {
  value: FooterContext;
  children: ReactNode;
}): ReactNode {
  return <FooterReactContext.Provider value={value}>{children}</FooterReactContext.Provider>;
}

/**
 * Access the current session snapshot from inside a plugin footer component.
 * Throws if used outside a `FooterContextProvider`.
 */
export function useFooterContext(): FooterContext {
  const ctx = useContext(FooterReactContext);
  if (ctx === null) {
    throw new Error('useFooterContext must be used within FooterContextProvider');
  }
  return ctx;
}
