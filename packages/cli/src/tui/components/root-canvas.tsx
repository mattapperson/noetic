/**
 * RootCanvas — pins the App's top-level Box to the terminal's exact cell
 * dimensions and refreshes them on `SIGWINCH`-driven `resize` events.
 *
 * Because noetic now runs inside the alternate screen buffer (see
 * `bootstrap-interactive.ts`), the terminal viewport IS the app canvas.
 * Without an explicit `width`/`height` on the root Box, Ink would grow the
 * layout to natural content size and the canvas would be sparsely filled or
 * overflow. Pinning to `stdout.columns × stdout.rows` makes borders span the
 * full viewport and reflow on resize.
 */

import { Box, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

interface CanvasSize {
  cols: number;
  rows: number;
}

function useCanvasSize(): CanvasSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<CanvasSize>({
    cols: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) {
      return;
    }
    const handler = (): void => {
      setSize({
        cols: stdout.columns,
        rows: stdout.rows,
      });
    };
    stdout.on('resize', handler);
    return (): void => {
      stdout.off('resize', handler);
    };
  }, [
    stdout,
  ]);
  return size;
}

export interface RootCanvasProps {
  children: ReactNode;
}

export function RootCanvas({ children }: RootCanvasProps): ReactNode {
  const { cols, rows } = useCanvasSize();
  return (
    <Box width={cols} height={rows} flexDirection="column">
      {children}
    </Box>
  );
}
