'use client';

import { useCallback, useEffect, useState } from 'react';
import { useHasHydrated } from './useHasHydrated';

interface ColumnWidths {
  left: number;
  right: number;
}

interface UseColumnWidthsOptions {
  defaultLeftWidth: number;
  defaultRightWidth: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
}

const STORAGE_KEY = 'noetic-ui:column-widths';

export function useColumnWidths(options: UseColumnWidthsOptions) {
  const {
    defaultLeftWidth,
    defaultRightWidth,
    minWidth = 200,
    maxWidth = 500,
    storageKey = STORAGE_KEY,
  } = options;

  const hasHydrated = useHasHydrated();

  // Always start with defaults for SSR/hydration consistency
  const [widths, setWidths] = useState<ColumnWidths>({
    left: defaultLeftWidth,
    right: defaultRightWidth,
  });

  // Load from localStorage after hydration
  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === 'object' && ('left' in parsed || 'right' in parsed)) {
          const partial = parsed as Partial<ColumnWidths>;
          setWidths({
            left: Math.max(minWidth, Math.min(maxWidth, partial.left ?? defaultLeftWidth)),
            right: Math.max(minWidth, Math.min(maxWidth, partial.right ?? defaultRightWidth)),
          });
        }
      }
    } catch {
      // Ignore parse errors - keep defaults
    }
  }, [
    hasHydrated,
    storageKey,
    minWidth,
    maxWidth,
    defaultLeftWidth,
    defaultRightWidth,
  ]);

  // Persist to localStorage whenever widths change
  useEffect(() => {
    if (!hasHydrated || typeof window === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Ignore storage errors (e.g., quota exceeded)
    }
  }, [
    widths,
    storageKey,
    hasHydrated,
  ]);

  const setLeftWidth = useCallback(
    (width: number) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, width));
      setWidths((prev) => ({
        ...prev,
        left: clamped,
      }));
    },
    [
      minWidth,
      maxWidth,
    ],
  );

  const setRightWidth = useCallback(
    (width: number) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, width));
      setWidths((prev) => ({
        ...prev,
        right: clamped,
      }));
    },
    [
      minWidth,
      maxWidth,
    ],
  );

  const resetWidths = useCallback(() => {
    setWidths({
      left: defaultLeftWidth,
      right: defaultRightWidth,
    });
  }, [
    defaultLeftWidth,
    defaultRightWidth,
  ]);

  return {
    leftWidth: widths.left,
    rightWidth: widths.right,
    setLeftWidth,
    setRightWidth,
    resetWidths,
    hasHydrated,
  };
}
