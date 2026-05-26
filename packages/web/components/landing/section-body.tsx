import type { ReactNode } from 'react';

interface SectionBodyProps {
  lede: string;
  detail: string;
}

export function SectionBody({ lede, detail }: SectionBodyProps): ReactNode {
  return (
    <>
      <p
        style={{
          fontSize: '17px',
          color: 'var(--color-tui-secondary)',
          margin: '0 0 8px',
          lineHeight: 1.5,
        }}
      >
        {lede}
      </p>
      <p
        style={{
          fontSize: '14px',
          color: 'var(--color-tui-muted)',
          margin: '0',
          lineHeight: 1.7,
        }}
      >
        {detail}
      </p>
    </>
  );
}
