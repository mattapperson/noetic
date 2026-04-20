import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { PreviewBlock } from '../types.js';
import { isKnownPreviewBlock } from '../types.js';
import { AsciiBlock } from './ascii-block.js';
import { CodeBlock } from './code-block.js';
import { MarkdownBlock } from './markdown-block.js';

interface PreviewBlockViewProps {
  block: PreviewBlock;
}

export function PreviewBlockView({ block }: PreviewBlockViewProps): ReactNode {
  if (!isKnownPreviewBlock(block)) {
    return (
      <Box paddingX={1}>
        <Text dimColor>[unsupported preview: {block.type}]</Text>
      </Box>
    );
  }
  if (block.type === 'text') {
    return (
      <Box paddingX={1}>
        <Text>{block.body}</Text>
      </Box>
    );
  }
  if (block.type === 'code') {
    return <CodeBlock language={block.language} source={block.source} />;
  }
  if (block.type === 'markdown') {
    return <MarkdownBlock body={block.body} />;
  }
  return <AsciiBlock body={block.body} />;
}
