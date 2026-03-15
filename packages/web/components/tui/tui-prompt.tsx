import type { ReactNode } from 'react';

interface TuiPromptProps {
  children: ReactNode;
  className?: string;
}

export function TuiPrompt({ children, className }: TuiPromptProps): ReactNode {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap: '8px',
        alignItems: 'baseline',
      }}
    >
      <span
        style={{
          color: 'var(--color-tui-green)',
          fontWeight: 700,
        }}
      >
        $
      </span>
      <span>{children}</span>
    </div>
  );
}
