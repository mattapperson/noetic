/**
 * Plan approval modal — shown when the model calls `plan/exitPlanMode { action: 'execute' }`.
 *
 * Displays the proposed PRD and (if present) flow tree. The user accepts to allow
 * execution to begin (host writes the PRD to disk and the planMemory layer
 * transitions to Executing) or rejects to keep planning.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from './theme.js';

//#region Types

export interface PlanApprovalModalProps {
  prd: string;
  planTree: unknown | null;
  onAccept: () => void;
  onReject: () => void;
}

//#endregion

//#region Component

const MAX_PRD_LINES = 24;

function truncatePrd(prd: string): {
  lines: string[];
  truncated: boolean;
} {
  const lines = prd.split('\n');
  if (lines.length <= MAX_PRD_LINES) {
    return {
      lines,
      truncated: false,
    };
  }
  return {
    lines: lines.slice(0, MAX_PRD_LINES),
    truncated: true,
  };
}

export function PlanApprovalModal({
  prd,
  planTree,
  onAccept,
  onReject,
}: PlanApprovalModalProps): ReactNode {
  const theme = useTheme();
  const { lines, truncated } = truncatePrd(prd);

  useInput((input, key) => {
    if (key.return || input === 'y' || input === 'Y') {
      onAccept();
      return;
    }
    if (key.escape || input === 'n' || input === 'N') {
      onReject();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} padding={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          Plan ready for approval
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>{lines.join('\n')}</Text>
        {truncated ? (
          <Text color={theme.muted}>
            … (PRD truncated for display; full content will be written to disk on accept)
          </Text>
        ) : null}
      </Box>

      {planTree ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.muted}>
            Flow attached
          </Text>
          <Text color={theme.muted}>(JSON flow will be written to flow.json on accept)</Text>
        </Box>
      ) : null}

      <Box>
        <Text color={theme.success}>[Y/Enter] Accept</Text>
        <Text>{'  '}</Text>
        <Text color={theme.error}>[N/Esc] Reject</Text>
      </Box>
    </Box>
  );
}

//#endregion
