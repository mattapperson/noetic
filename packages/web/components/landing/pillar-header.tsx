import type { ReactNode } from 'react';

interface PillarHeaderProps {
  id: string;
  index: string;
  name: string;
}

export function PillarHeader({ id, index, name }: PillarHeaderProps): ReactNode {
  return (
    <div
      id={id}
      style={{
        scrollMarginTop: '110px',
        maxWidth: '1280px',
        width: '100%',
        margin: '0 auto',
        padding: '64px 24px 0',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderTop: '1px solid var(--color-tui-border)',
          paddingTop: '20px',
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 700,
            color: 'var(--color-tui-green)',
            letterSpacing: '0.1em',
          }}
        >
          {index}
        </span>
        <span
          style={{
            color: 'var(--color-tui-muted)',
          }}
        >
          ·
        </span>
        <span
          style={{
            fontSize: '12px',
            fontWeight: 700,
            color: 'var(--color-tui-fg)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          {name}
        </span>
      </div>
    </div>
  );
}
