import type { CSSProperties, ReactNode } from 'react';

interface TuiReadoutProps {
  children: ReactNode;
  gap?: CSSProperties['gap'];
  color?: CSSProperties['color'];
}

export function TuiReadout({
  children,
  gap = '8px',
  color = 'var(--color-tui-secondary)',
}: TuiReadoutProps): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap,
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        background: 'var(--color-tui-surface)',
        border: '1px solid var(--color-tui-border)',
        padding: '20px',
        color,
        justifyContent: 'center',
      }}
    >
      {children}
    </div>
  );
}
