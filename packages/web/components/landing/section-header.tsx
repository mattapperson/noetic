import type { ReactNode } from 'react';

interface SectionHeaderProps {
  label: string;
  title: string;
  margin?: string;
}

export function SectionHeader({
  label,
  title,
  margin = '8px 0 40px',
}: SectionHeaderProps): ReactNode {
  return (
    <>
      <span
        style={{
          fontSize: '13px',
          color: 'var(--color-tui-muted)',
          letterSpacing: '0.1em',
        }}
      >
        {`// ${label}`}
      </span>
      <h2
        style={{
          fontSize: '28px',
          fontWeight: 700,
          margin,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {title}
      </h2>
    </>
  );
}
