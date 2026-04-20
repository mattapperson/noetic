import { Box, Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { ReactNode } from 'react';

interface MarkdownBlockProps {
  body: string;
  maxLines?: number;
}

const MAX_LINES = 16;

// Single shared Marked instance; marked-terminal registers chalk-based renderers.
const marked = new Marked();
marked.use(
  markedTerminal({
    reflowText: false,
    width: 60,
  }),
);

export function MarkdownBlock({ body, maxLines = MAX_LINES }: MarkdownBlockProps): ReactNode {
  const rendered = renderMarkdown(body);
  const { visible, hidden } = truncate(rendered, maxLines);
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

function renderMarkdown(body: string): string {
  try {
    const result = marked.parse(body);
    if (typeof result === 'string') {
      return result.trimEnd();
    }
    return body;
  } catch {
    return body;
  }
}

function truncate(
  text: string,
  maxLines: number,
): {
  visible: string;
  hidden: number;
} {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return {
      visible: text,
      hidden: 0,
    };
  }
  return {
    visible: lines.slice(0, maxLines).join('\n'),
    hidden: lines.length - maxLines,
  };
}
