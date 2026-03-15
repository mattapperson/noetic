'use client';

import type { ReactNode } from 'react';
import { BOX, FRAME_FILL, FRAME_TITLE_FILL } from '@/lib/tui-theme';

const BOTTOM_LINE = `${BOX.bottomLeft}${FRAME_FILL}${BOX.bottomRight}`;

interface TuiFrameProps {
  children: ReactNode;
  title?: string;
  className?: string;
}

export function TuiFrame({ children, title, className }: TuiFrameProps): ReactNode {
  const topLine = title
    ? `${BOX.topLeft}${BOX.horizontal} ${title} ${FRAME_TITLE_FILL}${BOX.topRight}`
    : `${BOX.topLeft}${FRAME_FILL}${BOX.topRight}`;

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        fontFamily: 'var(--font-mono), monospace',
      }}
    >
      <div
        style={{
          color: 'var(--color-tui-border)',
          fontSize: '14px',
          lineHeight: '1.4',
          whiteSpace: 'pre',
          overflow: 'hidden',
        }}
      >
        {topLine}
      </div>
      <div
        style={{
          borderLeft: '1px solid var(--color-tui-border)',
          borderRight: '1px solid var(--color-tui-border)',
          padding: '16px',
        }}
      >
        {children}
      </div>
      <div
        style={{
          color: 'var(--color-tui-border)',
          fontSize: '14px',
          lineHeight: '1.4',
          whiteSpace: 'pre',
          overflow: 'hidden',
        }}
      >
        {BOTTOM_LINE}
      </div>
    </div>
  );
}
