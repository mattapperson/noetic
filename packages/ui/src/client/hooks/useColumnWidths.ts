'use client';

import { useCallback, useEffect, useState } from 'react';

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

  // Initialize from localStorage or defaults
  const [widths, setWidths] = useState<ColumnWidths>(() => {
    if (typeof window === 'undefined') {
      return {
        left: defaultLeftWidth,
        right: defaultRightWidth,
      };
    }

    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ColumnWidths>;
        return {
          left: Math.max(minWidth, Math.min(maxWidth, parsed.left ?? defaultLeftWidth)),
          right: Math.max(minWidth, Math.min(maxWidth, parsed.right ?? defaultRightWidth)),
        };
      }
    } catch {
      // Ignore parse errors and fall back to defaults
    }

    return {
      left: defaultLeftWidth,
      right: defaultRightWidth,
    };
  });

  // Persist to localStorage whenever widths change
  useEffect(() => {
    if (typeof window === 'undefined') {
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
  };
}
