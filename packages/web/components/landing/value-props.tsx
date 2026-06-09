import Link from 'next/link';
import type { ReactNode } from 'react';

interface ValueProp {
  readonly index: string;
  readonly pillar: string;
  readonly headline: string;
  readonly support: string;
  readonly href: string;
  readonly color: string;
}

const VALUE_PROPS: ReadonlyArray<ValueProp> = [
  {
    index: '01',
    pillar: 'COMPOSE',
    headline: "It's just TypeScript.",
    support: 'Seven primitives you read, fork, and own.',
    href: '#compose',
    color: 'var(--color-tui-green)',
  },
  {
    index: '02',
    pillar: 'REMEMBER',
    headline: "Context that doesn't blow up.",
    support: 'Nine memory layers keep token costs flat.',
    href: '#remember',
    color: 'var(--color-tui-cyan)',
  },
  {
    index: '03',
    pillar: 'ENDURE',
    headline: 'Survives production.',
    support: 'Checkpoint and resume — Node, browser, or sandbox.',
    href: '#endure',
    color: 'var(--color-tui-amber)',
  },
  {
    index: '04',
    pillar: 'PROVE',
    headline: 'Prove it works.',
    support: 'Score and optimize like Jest tests.',
    href: '#prove',
    color: 'var(--color-tui-green)',
  },
];

export function ValueProps(): ReactNode {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: '960px',
        margin: '0 auto',
        borderTop: '1px solid var(--color-tui-border)',
        borderBottom: '1px solid var(--color-tui-border)',
        padding: '20px 0',
      }}
    >
      <div className="value-props-grid">
        {VALUE_PROPS.map((prop) => (
          <Link
            key={prop.pillar}
            href={prop.href}
            style={{
              display: 'block',
              textDecoration: 'none',
              color: 'inherit',
              padding: '0 12px',
              textAlign: 'left',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.18em',
                color: prop.color,
                marginBottom: '6px',
              }}
            >
              {prop.index} · {prop.pillar}
            </div>
            <div
              style={{
                fontSize: '14px',
                fontWeight: 700,
                color: 'var(--color-tui-fg)',
                marginBottom: '4px',
                lineHeight: 1.3,
              }}
            >
              {prop.headline}
            </div>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--color-tui-secondary)',
                lineHeight: 1.4,
              }}
            >
              {prop.support}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
