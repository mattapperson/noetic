import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

interface AsciiBlockProps {
  body: string;
  maxLines?: number;
}

const MAX_LINES = 16;

export function AsciiBlock({ body, maxLines = MAX_LINES }: AsciiBlockProps): ReactNode {
  const lines = body.split('\n');
  const hidden = lines.length > maxLines ? lines.length - maxLines : 0;
  const visible = hidden > 0 ? lines.slice(0, maxLines).join('\n') : body;
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text>{visible}</Text>
      {hidden > 0 ? (
        <Text dimColor>
          … {hidden} more line{hidden === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Box>
  );
}
