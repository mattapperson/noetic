'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiBadge } from '@/components/tui/tui-badge';
import { HOVER_BG } from '@/lib/tui-theme';

interface EnduranceCard {
  name: string;
  tag: string;
  color: 'green' | 'cyan' | 'amber';
  description: string;
  href?: string;
}

const CARDS: EnduranceCard[] = [
  {
    name: 'Durable execution',
    tag: 'durable',
    color: 'amber',
    description: 'Checkpoint and resume long runs — they survive crashes and restarts.',
    href: '/docs/framework/durability',
  },
  {
    name: 'Runs anywhere',
    tag: 'portable',
    color: 'cyan',
    description:
      'Node, the browser, or a sandbox. Swap the fs, shell, and llm adapters; Mirage gives you a virtual filesystem.',
  },
  {
    name: 'JSON workflow runtime',
    tag: 'declarative',
    color: 'green',
    description: 'Define an agent declaratively as JSON and run it. Same primitives, no code.',
    href: '/docs/framework/json-runtime',
  },
];

function CardBody({ card }: { card: EnduranceCard }): ReactNode {
  return (
    <motion.div
      whileHover={HOVER_BG}
      style={{
        background: 'var(--color-tui-surface)',
        padding: '32px',
        height: '100%',
        transition: 'background 0.1s',
      }}
    >
      <div
        style={{
          marginBottom: '12px',
        }}
      >
        <TuiBadge color={card.color}>{card.tag}</TuiBadge>
      </div>
      <h3
        style={{
          fontSize: '18px',
          fontWeight: 700,
          color: 'var(--color-tui-fg)',
          letterSpacing: '-0.01em',
          margin: '0 0 8px',
        }}
      >
        {card.name}
      </h3>
      <p
        style={{
          fontSize: '14px',
          color: 'var(--color-tui-secondary)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {card.description}
      </p>
    </motion.div>
  );
}

export function Endurance(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        margin: '0 auto',
      }}
    >
      <SectionHeader
        label="production-grade"
        title="Built to survive production"
        margin="8px 0 12px"
      />
      <p
        style={{
          fontSize: '17px',
          color: 'var(--color-tui-secondary)',
          margin: '0 0 32px',
          lineHeight: 1.5,
        }}
      >
        The parts that matter once an agent leaves your laptop.
      </p>

      <div className="tui-bento endure-grid">
        {CARDS.map((card) =>
          card.href ? (
            <Link
              key={card.name}
              href={card.href}
              style={{
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <CardBody card={card} />
            </Link>
          ) : (
            <div key={card.name}>
              <CardBody card={card} />
            </div>
          ),
        )}
      </div>
    </section>
  );
}
