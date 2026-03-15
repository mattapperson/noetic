import type { ReactNode } from 'react';

const BADGE_COLORS = {
  green: 'var(--color-tui-green)',
  amber: 'var(--color-tui-amber)',
  cyan: 'var(--color-tui-cyan)',
  muted: 'var(--color-tui-muted)',
} as const;

type BadgeColor = keyof typeof BADGE_COLORS;

interface TuiBadgeProps {
  children: ReactNode;
  color?: BadgeColor;
}

export function TuiBadge({ children, color = 'green' }: TuiBadgeProps): ReactNode {
  const badgeColor = BADGE_COLORS[color];

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        fontSize: '10px',
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: badgeColor,
        border: `1px solid ${badgeColor}`,
        borderRadius: '2px',
      }}
    >
      {children}
    </span>
  );
}
