import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { DeckOption } from '../types.js';
import { PreviewBlockView } from './preview-block.js';

interface OptionCardProps {
  option: DeckOption;
  index: number;
  focused: boolean;
  selected: boolean;
  width?: number;
}

export function OptionCard({
  option,
  index,
  focused,
  selected,
  width,
}: OptionCardProps): ReactNode {
  const marker = selected ? '▸' : focused ? '•' : ' ';
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? 'double' : 'round'}
      borderColor={selected ? 'green' : focused ? 'cyan' : undefined}
      borderDimColor={!focused && !selected}
      paddingX={1}
      paddingY={0}
      width={width}
      flexGrow={1}
    >
      <Box flexDirection="row">
        <Text color={selected ? 'green' : focused ? 'cyan' : undefined} bold>
          {marker} {index + 1}. {option.label}
        </Text>
        {option.recommended ? <Text color="yellow"> ★</Text> : null}
      </Box>
      {option.description ? (
        <Box>
          <Text dimColor>{option.description}</Text>
        </Box>
      ) : null}
      {option.previewBlocks.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {option.previewBlocks.map((block, i) => (
            <PreviewBlockView
              // biome-ignore lint/suspicious/noArrayIndexKey: preview block order is stable for a given option
              key={`${block.type}-${i}`}
              block={block}
            />
          ))}
        </Box>
      ) : null}
      {option.aside ? (
        <Box marginTop={1}>
          <Text dimColor italic>
            {option.aside}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
