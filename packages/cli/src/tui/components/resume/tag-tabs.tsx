/**
 * Horizontal tag-filter strip shown above the session list. Adapted from
 * Claude Code's `TagTabs` (src/components/TagTabs.tsx) with our own theme
 * and keyboard handling (`Tab` / `Shift+Tab` to cycle).
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from '../theme.js';

export interface TagTabsProps {
  /** Distinct tags, ordered. `null` represents the "All" tab. */
  tags: ReadonlyArray<string>;
  /** Currently-selected tag or `null` for All. */
  activeTag: string | null;
}

export function TagTabs({ tags, activeTag }: TagTabsProps): ReactNode {
  const theme = useTheme();
  if (tags.length === 0) {
    return null;
  }
  const entries: Array<string | null> = [
    null,
    ...tags,
  ];
  return (
    <Box>
      {entries.map((tag, idx) => {
        const isActive = tag === activeTag;
        const label = tag === null ? 'all' : `#${tag}`;
        const color = isActive ? theme.primary : theme.muted;
        return (
          <Box key={tag ?? '__all'} marginRight={idx === entries.length - 1 ? 0 : 2}>
            <Text color={color} bold={isActive}>
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
