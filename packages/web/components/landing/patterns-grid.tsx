'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiBadge } from '@/components/tui/tui-badge';
import { TuiWindow } from '@/components/tui/tui-window';
import type { PrimitiveName } from '@/lib/tui-theme';
import { HOVER_BG } from '@/lib/tui-theme';

interface PatternCard {
  name: string;
  lines: string;
  primitives: PrimitiveName[];
  href: string;
}

const PATTERNS: PatternCard[] = [
  {
    name: 'ReAct',
    lines: '~15 lines',
    primitives: [
      'loop',
      'llm',
      'tool',
    ],
    href: '/docs/patterns/react',
  },
  {
    name: 'Ralph Wiggum',
    lines: '~10 lines',
    primitives: [
      'loop',
      'llm',
      'tool',
    ],
    href: '/docs/patterns/ralph-wiggum',
  },
  {
    name: 'Task Trees',
    lines: '~40 lines',
    primitives: [
      'fork',
      'spawn',
      'llm',
    ],
    href: '/docs/patterns/task-trees',
  },
  {
    name: 'Adaptive Plans',
    lines: '~35 lines',
    primitives: [
      'loop',
      'branch',
      'llm',
    ],
    href: '/docs/patterns/adaptive-plans',
  },
  {
    name: 'Thread Weaving',
    lines: '~25 lines',
    primitives: [
      'fork',
      'llm',
      'run',
    ],
    href: '/docs/patterns/thread-weaving',
  },
  {
    name: 'Dual Agent',
    lines: '~20 lines',
    primitives: [
      'spawn',
      'llm',
      'branch',
    ],
    href: '/docs/patterns/dual-agent',
  },
];

export function PatternsGrid(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '960px',
        margin: '0 auto',
      }}
    >
      <SectionHeader label="batteries included" title="Built-in Patterns" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1px',
          background: 'var(--color-tui-border)',
          border: '1px solid var(--color-tui-border)',
        }}
      >
        {PATTERNS.map((pattern) => (
          <Link
            key={pattern.name}
            href={pattern.href}
            style={{
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <motion.div
              whileHover={HOVER_BG}
              style={{
                background: 'var(--color-tui-surface)',
                padding: '20px',
                height: '100%',
                transition: 'background 0.1s',
              }}
            >
              <TuiWindow title={pattern.name}>
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--color-tui-muted)',
                    marginBottom: '12px',
                  }}
                >
                  {pattern.lines}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: '6px',
                    flexWrap: 'wrap',
                  }}
                >
                  {pattern.primitives.map((p) => (
                    <TuiBadge key={p} color="muted">
                      {p}
                    </TuiBadge>
                  ))}
                </div>
              </TuiWindow>
            </motion.div>
          </Link>
        ))}
      </div>
    </section>
  );
}
