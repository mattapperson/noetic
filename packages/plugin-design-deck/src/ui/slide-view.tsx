import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { DeckSelections, Slide } from '../types.js';
import { OptionCard } from './option-card.js';

interface SlideViewProps {
  slide: Slide;
  focusIndex: number;
  selections: DeckSelections;
  generating: boolean;
}

export function SlideView({
  slide,
  focusIndex,
  selections,
  generating,
}: SlideViewProps): ReactNode {
  const selectedLabel = selections[slide.id];
  const columns = slide.columns ?? pickColumns(slide.options.length);
  return (
    <Box flexDirection="column">
      {slide.context ? (
        <Box marginBottom={1}>
          <Text dimColor>{slide.context}</Text>
        </Box>
      ) : null}
      <OptionGrid
        slideOptions={slide.options}
        focusIndex={focusIndex}
        selectedLabel={selectedLabel}
        columns={columns}
      />
      {generating ? (
        <Box marginTop={1}>
          <Text dimColor>Generating more options…</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function pickColumns(count: number): 1 | 2 | 3 | 4 {
  if (count >= 4) {
    return 4;
  }
  if (count === 3) {
    return 3;
  }
  if (count === 2) {
    return 2;
  }
  return 1;
}

interface OptionGridProps {
  slideOptions: Slide['options'];
  focusIndex: number;
  selectedLabel: string | undefined;
  columns: 1 | 2 | 3 | 4;
}

function OptionGrid({
  slideOptions,
  focusIndex,
  selectedLabel,
  columns,
}: OptionGridProps): ReactNode {
  const rows: Slide['options'][] = [];
  for (let i = 0; i < slideOptions.length; i += columns) {
    rows.push(slideOptions.slice(i, i + columns));
  }
  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: row order is fixed by slice index
          key={`row-${rowIndex}`}
          flexDirection="row"
        >
          {row.map((option, colIndex) => {
            const flatIndex = rowIndex * columns + colIndex;
            return (
              <OptionCard
                key={`${flatIndex}-${option.label}`}
                option={option}
                index={flatIndex}
                focused={flatIndex === focusIndex}
                selected={option.label === selectedLabel}
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
