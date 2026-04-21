import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

const HINTS = [
  '← → slide',
  '↑ ↓ focus',
  '1-9 select',
  'Space toggle',
  'G generate',
  'S save',
  'Enter submit',
  'Esc cancel',
];

export function ShortcutsHint(): ReactNode {
  return (
    <Box flexDirection="row">
      {HINTS.map((hint, i) => (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: hints are a fixed static list
          key={`hint-${i}`}
        >
          <Text dimColor>{hint}</Text>
          {i < HINTS.length - 1 ? <Text dimColor> · </Text> : null}
        </Box>
      ))}
    </Box>
  );
}
