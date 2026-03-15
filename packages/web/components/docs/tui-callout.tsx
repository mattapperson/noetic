import type { ReactNode } from 'react';

const CALLOUT_COLORS = {
  info: 'var(--color-tui-cyan)',
  warn: 'var(--color-tui-amber)',
  tip: 'var(--color-tui-green)',
} as const;

type CalloutType = keyof typeof CALLOUT_COLORS;

interface TuiCalloutProps {
  children: ReactNode;
  type?: CalloutType;
  title?: string;
}

export function TuiCallout({ children, type = 'info', title }: TuiCalloutProps): ReactNode {
  const color = CALLOUT_COLORS[type];

  return (
    <div
      style={{
        borderLeft: `3px solid ${color}`,
        padding: '12px 16px',
        margin: '16px 0',
        background: 'var(--color-tui-surface)',
      }}
    >
      {title && (
        <div
          style={{
            fontSize: '12px',
            fontWeight: 700,
            color,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '6px',
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          fontSize: '14px',
          color: 'var(--color-tui-secondary)',
          lineHeight: 1.6,
        }}
      >
        {children}
      </div>
    </div>
  );
}
