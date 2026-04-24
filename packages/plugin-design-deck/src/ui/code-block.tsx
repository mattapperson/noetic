import { highlight, supportsLanguage } from 'cli-highlight';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

const MAX_LINES = 16;

interface CodeBlockProps {
  language: string;
  source: string;
  maxLines?: number;
}

export function CodeBlock({ language, source, maxLines = MAX_LINES }: CodeBlockProps): ReactNode {
  const lang = supportsLanguage(language) ? language : 'text';
  const { lines, hidden } = truncate(source, maxLines);
  const highlighted = safeHighlight(lines.join('\n'), lang);
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text>{highlighted}</Text>
      {hidden > 0 ? (
        <Text dimColor>
          … {hidden} more line{hidden === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Box>
  );
}

function truncate(
  source: string,
  maxLines: number,
): {
  lines: string[];
  hidden: number;
} {
  const all = source.split('\n');
  if (all.length <= maxLines) {
    return {
      lines: all,
      hidden: 0,
    };
  }
  return {
    lines: all.slice(0, maxLines),
    hidden: all.length - maxLines,
  };
}

function safeHighlight(source: string, language: string): string {
  try {
    return highlight(source, {
      language,
      ignoreIllegals: true,
    });
  } catch {
    return source;
  }
}
