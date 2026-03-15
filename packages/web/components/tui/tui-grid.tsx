import type { CSSProperties, ReactNode } from 'react';

interface TuiGridProps {
  children: ReactNode;
  columns?: number;
  gap?: number;
  className?: string;
  style?: CSSProperties;
}

export function TuiGrid({
  children,
  columns = 2,
  gap = 1,
  className,
  style,
}: TuiGridProps): ReactNode {
  return (
    <div
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: `${gap}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
