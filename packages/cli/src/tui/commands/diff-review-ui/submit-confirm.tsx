/**
 * Submit-confirm modal — shows a preview of the composed prompt, awaits y/n.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from '../../components/theme.js';

//#region Props

export interface SubmitConfirmProps {
  prompt: string;
  onConfirm: () => void;
  onCancel: () => void;
}

//#endregion

//#region Component

export function SubmitConfirm({ prompt, onConfirm, onCancel }: SubmitConfirmProps): ReactNode {
  const theme = useTheme();

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    const lower = input.toLowerCase();
    if (lower === 'y' || key.return) {
      onConfirm();
      return;
    }
    if (lower === 'n') {
      onCancel();
    }
  });

  const allLines = prompt.split('\n');
  const lines = allLines.slice(0, 20).map((text, idx) => ({
    key: `${idx}:${text.slice(0, 24)}`,
    text,
  }));
  const remaining = allLines.length - lines.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.primary}>
        Send review feedback to agent?
      </Text>
      <Box marginTop={1} flexDirection="column">
        {lines.map((line) => (
          <Text key={line.key} color={theme.foreground}>
            {line.text || ' '}
          </Text>
        ))}
        {remaining > 0 ? <Text dimColor>… {remaining} more lines</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>y / Enter to send · n / Esc to cancel</Text>
      </Box>
    </Box>
  );
}

//#endregion
