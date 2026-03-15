'use client';

import type { ReactNode } from 'react';
import { WINDOW_DOT_GREEN, WINDOW_DOT_RED, WINDOW_DOT_YELLOW } from '@/lib/tui-theme';

interface TuiWindowProps {
  children: ReactNode;
  title?: string;
  className?: string;
}

export function TuiWindow({ children, title, className }: TuiWindowProps): ReactNode {
  return (
    <div
      className={className}
      style={{
        background: 'var(--color-tui-surface)',
        border: '1px solid var(--color-tui-border)',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-tui-border)',
          background: 'var(--color-tui-bg)',
        }}
      >
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: WINDOW_DOT_RED,
          }}
        />
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: WINDOW_DOT_YELLOW,
          }}
        />
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: WINDOW_DOT_GREEN,
          }}
        />
        {title && (
          <span
            style={{
              marginLeft: '8px',
              fontSize: '12px',
              color: 'var(--color-tui-muted)',
              letterSpacing: '0.05em',
            }}
          >
            {title}
          </span>
        )}
      </div>
      <div
        style={{
          padding: '16px',
          fontSize: '14px',
          lineHeight: '1.6',
        }}
      >
        {children}
      </div>
    </div>
  );
}
