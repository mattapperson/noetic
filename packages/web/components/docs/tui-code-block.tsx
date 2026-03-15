import type { ReactNode } from 'react';

interface TuiCodeBlockProps {
  children: ReactNode;
  title?: string;
}

export function TuiCodeBlock({ children, title }: TuiCodeBlockProps): ReactNode {
  return (
    <div
      style={{
        background: 'var(--color-tui-surface)',
        border: '1px solid var(--color-tui-border)',
        borderRadius: '4px',
        overflow: 'hidden',
        margin: '16px 0',
      }}
    >
      {title && (
        <div
          style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--color-tui-border)',
            fontSize: '12px',
            color: 'var(--color-tui-muted)',
            letterSpacing: '0.05em',
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          padding: '16px',
          fontSize: '13px',
          lineHeight: 1.7,
          overflow: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  );
}
