'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiBadge } from '@/components/tui/tui-badge';

interface BenchmarkCard {
  rank: string;
  name: string;
  subtitle: string;
  detail: string;
}

const BENCHMARKS: BenchmarkCard[] = [
  {
    rank: '#1',
    name: 'Terminal-Bench',
    subtitle: 'end-to-end software engineering in a real shell',
    detail: 'Measures the full loop: read, edit, run, recover. Not just code completion.',
  },
  {
    rank: '#1',
    name: 'Long-Mem Eval',
    subtitle: 'coherence across hours of context',
    detail: 'Tests whether an agent still remembers turn 3 when it reaches turn 300.',
  },
];

export function CodeBenchmarks(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        margin: '0 auto',
      }}
    >
      <SectionHeader label="how it stacks up" title="Benchmarked, not vibes" />

      <div
        className="patterns-grid"
        style={{
          display: 'grid',
          gap: '4px',
        }}
      >
        {BENCHMARKS.map((bench, i) => (
          <motion.div
            key={bench.name}
            initial={{
              opacity: 0,
              y: 10,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            transition={{
              delay: i * 0.08,
              duration: 0.3,
            }}
            viewport={{
              once: true,
            }}
            style={{
              background: 'var(--color-tui-surface)',
              border: '1px solid var(--color-tui-border)',
              padding: '32px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '16px',
              }}
            >
              <span
                className="tui-glow"
                style={{
                  fontSize: 'clamp(48px, 7vw, 72px)',
                  fontWeight: 800,
                  color: 'var(--color-tui-green)',
                  lineHeight: 1,
                  letterSpacing: '-0.02em',
                }}
              >
                {bench.rank}
              </span>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <span
                  style={{
                    fontSize: '18px',
                    fontWeight: 700,
                    color: 'var(--color-tui-fg)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {bench.name}
                </span>
                <span
                  style={{
                    fontSize: '13px',
                    color: 'var(--color-tui-muted)',
                  }}
                >
                  {bench.subtitle}
                </span>
              </div>
            </div>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-secondary)',
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              {bench.detail}
            </p>
          </motion.div>
        ))}
      </div>

      <p
        style={{
          marginTop: '24px',
          padding: '14px 16px',
          border: '1px solid var(--color-tui-border)',
          fontSize: '12px',
          color: 'var(--color-tui-muted)',
          background: 'var(--color-tui-surface)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          letterSpacing: '0.04em',
        }}
      >
        <TuiBadge color="amber">verification pending</TuiBadge>
        <span>
          Scores and methodology publishing soon. Reproduce locally with{' '}
          <code
            style={{
              fontFamily: 'var(--font-mono)',
            }}
          >
            noetic test
          </code>
          .
        </span>
      </p>
    </section>
  );
}
