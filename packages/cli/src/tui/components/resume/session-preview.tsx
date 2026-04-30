/**
 * Detail panel shown next to the selected row in the resume picker. Adapted
 * from Claude Code's `SessionPreview` (src/components/SessionPreview.tsx) —
 * the upstream pulls a full transcript preview via `loadFullLog`; ours
 * shows just metadata since our session files are already small enough to
 * load without a lite/full split.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { SessionMetadata } from '../../../sessions/types.js';
import { useTheme } from '../theme.js';
import { formatRelativeTimeAgo, truncateFirstPrompt } from './format.js';

export interface SessionPreviewProps {
  session: SessionMetadata;
}

export function SessionPreview({ session }: SessionPreviewProps): ReactNode {
  const theme = useTheme();
  const title = session.customTitle ?? truncateFirstPrompt(session.firstPrompt);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold color={theme.primary}>
        {title.length > 0 ? title : '(no title)'}
      </Text>
      <Box>
        <Text color={theme.muted}>created </Text>
        <Text>{formatRelativeTimeAgo(session.createdAt)}</Text>
        <Text color={theme.muted}> · last turn </Text>
        <Text>{formatRelativeTimeAgo(session.modifiedAt)}</Text>
      </Box>
      <Box>
        <Text color={theme.muted}>model </Text>
        <Text>{session.model}</Text>
        <Text color={theme.muted}> · {session.messageCount} msgs</Text>
        {session.tag !== undefined ? (
          <>
            <Text color={theme.muted}> · </Text>
            <Text color={theme.accent}>#{session.tag}</Text>
          </>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>cwd </Text>
        <Text>{session.cwd}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>id </Text>
        <Text dimColor>{session.sessionId}</Text>
      </Box>
    </Box>
  );
}
