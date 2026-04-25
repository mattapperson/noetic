/**
 * Single option row within a Select list.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/CustomSelect/select-option.tsx
 * (reference delegates to a ListItem design-system component; this version
 * renders directly against stock Ink using Noetic's theme).
 *
 * Plain-string children are wrapped in `<Text>` so theme styling applies.
 * Element children (e.g. the input-mode editor) are rendered as siblings of
 * the marker row, because Ink forbids nesting `<Box>` inside `<Text>`.
 */

import figures from 'figures';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { isValidElement } from 'react';
import { useTheme } from '../theme.js';

//#region Props

export interface SelectOptionProps {
  readonly isFocused: boolean;
  readonly isSelected: boolean;
  readonly disabled?: boolean;
  readonly indexLabel?: string;
  readonly description?: string;
  readonly children: ReactNode;
  /** When true, renders description inline after the label instead of on its own line. */
  readonly inlineDescription?: boolean;
}

//#endregion

//#region Component

function isPlainTextNode(node: ReactNode): boolean {
  if (typeof node === 'string' || typeof node === 'number') {
    return true;
  }
  if (node === null || node === undefined || typeof node === 'boolean') {
    return true;
  }
  if (Array.isArray(node)) {
    return node.every(isPlainTextNode);
  }
  // Any React element is treated as non-plain so it's rendered outside a Text wrapper.
  return !isValidElement(node);
}

export function SelectOption({
  isFocused,
  isSelected,
  disabled,
  indexLabel,
  description,
  children,
  inlineDescription,
}: SelectOptionProps) {
  const theme = useTheme();
  const marker = isFocused ? figures.pointer : ' ';
  const checkmark = isSelected ? figures.tick : ' ';

  const labelColor = disabled ? theme.muted : isFocused ? theme.primary : theme.foreground;
  const descColor = theme.muted;
  const plainChildren = isPlainTextNode(children);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isFocused ? theme.accent : theme.muted}>{marker}</Text>
        <Text color={theme.secondary}> {checkmark} </Text>
        {indexLabel ? <Text color={theme.muted}>{indexLabel} </Text> : null}
        {plainChildren ? (
          <Text color={labelColor} bold={isFocused}>
            {children}
          </Text>
        ) : (
          children
        )}
        {inlineDescription && description ? <Text color={descColor}> — {description}</Text> : null}
      </Box>
      {!inlineDescription && description ? (
        <Box paddingLeft={5}>
          <Text color={descColor}>{description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

//#endregion
