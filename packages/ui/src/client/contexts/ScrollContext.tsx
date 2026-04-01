'use client';

/**
 * Context for tracking which run should be scrolled into view in the left nav
 */

import type React from 'react';
import { createContext, useCallback, useContext, useState } from 'react';

interface ScrollContextType {
  runIdToScroll: string | null;
  scrollToRun: (runId: string | null) => void;
}

const ScrollContext = createContext<ScrollContextType | undefined>(undefined);

export const ScrollProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [runIdToScroll, setRunIdToScroll] = useState<string | null>(null);

  const scrollToRun = useCallback((runId: string | null) => {
    setRunIdToScroll(runId);
  }, []);

  return (
    <ScrollContext.Provider
      value={{
        runIdToScroll,
        scrollToRun,
      }}
    >
      {children}
    </ScrollContext.Provider>
  );
};

export function useScroll(): ScrollContextType {
  const context = useContext(ScrollContext);
  if (context === undefined) {
    throw new Error('useScroll must be used within a ScrollProvider');
  }
  return context;
}
