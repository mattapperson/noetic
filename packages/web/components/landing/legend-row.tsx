import type { ReactNode } from 'react';

interface LegendItem {
  readonly color: string;
  readonly label: string;
}

interface LegendRowProps {
  items: ReadonlyArray<LegendItem>;
}

export function LegendRow({ items }: LegendRowProps): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        gap: '24px',
        alignItems: 'center',
        marginBottom: '12px',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontSize: '11px',
          color: 'var(--color-tui-muted)',
          letterSpacing: '0.08em',
        }}
      >
        LEGEND
      </span>
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: item.color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: '11px',
              color: 'var(--color-tui-muted)',
            }}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}
