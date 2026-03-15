import type { ReactNode } from 'react';

interface AsciiArtProps {
  art: string;
  color?: string;
  className?: string;
}

export function AsciiArt({
  art,
  color = 'var(--color-tui-green)',
  className,
}: AsciiArtProps): ReactNode {
  return (
    <pre
      className={className}
      style={{
        color,
        fontSize: '12px',
        lineHeight: '1.2',
        fontFamily: 'var(--font-mono), monospace',
        margin: 0,
        textAlign: 'center',
      }}
    >
      {art}
    </pre>
  );
}
