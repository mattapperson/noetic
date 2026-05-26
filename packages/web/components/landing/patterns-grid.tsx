'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { PatternsIsometricSvg } from '@/components/landing/svgs/patterns-isometric';
import { TuiBadge } from '@/components/tui/tui-badge';
import type { PrimitiveName } from '@/lib/tui-theme';
import { HOVER_BG, PRIMITIVE_COLORS } from '@/lib/tui-theme';

function getBadgeColor(primitive: PrimitiveName): 'cyan' | 'green' {
  const colorMap: Record<string, 'cyan' | 'green'> = {
    'tui-cyan': 'cyan',
    'tui-green': 'green',
  };
  return colorMap[PRIMITIVE_COLORS[primitive]] ?? 'cyan';
}

interface PatternCard {
  name: string;
  subtitle: string;
  lines: string;
  primitives: PrimitiveName[];
  href: string;
}

const PATTERNS: PatternCard[] = [
  {
    name: 'ReAct',
    subtitle: 'Reason, act, observe loops',
    lines: '~15 lines',
    primitives: [
      'loop',
      'llm',
      'tool',
    ],
    href: '/docs/framework/patterns/react',
  },
  {
    name: 'Ralph Wiggum',
    subtitle: 'Simple single-shot LLM calls',
    lines: '~10 lines',
    primitives: [
      'loop',
      'llm',
      'tool',
    ],
    href: '/docs/framework/patterns/ralph-wiggum',
  },
  {
    name: 'Task Trees',
    subtitle: 'Parallel sub-agent hierarchies',
    lines: '~40 lines',
    primitives: [
      'fork',
      'spawn',
      'llm',
    ],
    href: '/docs/framework/patterns/task-trees',
  },
  {
    name: 'Adaptive Plans',
    subtitle: 'Dynamic plan rewriting mid-run',
    lines: '~35 lines',
    primitives: [
      'loop',
      'branch',
      'llm',
    ],
    href: '/docs/framework/patterns/adaptive-plans',
  },
  {
    name: 'Thread Weaving',
    subtitle: 'Interleaved parallel workstreams',
    lines: '~25 lines',
    primitives: [
      'fork',
      'llm',
      'run',
    ],
    href: '/docs/framework/patterns/thread-weaving',
  },
  {
    name: 'Dual Agent',
    subtitle: 'Critic + generator collaboration',
    lines: '~20 lines',
    primitives: [
      'spawn',
      'llm',
      'branch',
    ],
    href: '/docs/framework/patterns/dual-agent',
  },
];

export function PatternsGrid(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        margin: '0 auto',
      }}
    >
      <div
        className="section-split"
        style={{
          marginBottom: '48px',
        }}
      >
        <div>
          <SectionHeader label="ready to use" title="Batteries included" margin="8px 0 12px" />
          <p
            style={{
              fontSize: '17px',
              color: 'var(--color-tui-secondary)',
              margin: '0 0 8px',
              lineHeight: 1.5,
            }}
          >
            Common agent patterns built-in for convenience.
          </p>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--color-tui-muted)',
              margin: '0',
              lineHeight: 1.7,
            }}
          >
            Each pattern is a composition of the primitives above — no special cases, no hidden
            behavior. Read the source. Fork it. The framework doesn't care.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
          }}
        >
          <PatternsIsometricSvg />
        </div>
      </div>

      <div className="tui-bento patterns-grid">
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
                padding: '32px',
                height: '100%',
                transition: 'background 0.1s',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '12px',
                  marginBottom: '12px',
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
                  {pattern.name}
                </span>
                <span
                  style={{
                    fontSize: '12px',
                    color: 'var(--color-tui-muted)',
                    fontWeight: 500,
                  }}
                >
                  {pattern.lines}
                </span>
              </div>
              <p
                style={{
                  fontSize: '14px',
                  color: 'var(--color-tui-secondary)',
                  margin: '0 0 16px',
                  lineHeight: 1.5,
                }}
              >
                {pattern.subtitle}
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  flexWrap: 'wrap',
                }}
              >
                {pattern.primitives.map((p) => (
                  <TuiBadge key={p} color={getBadgeColor(p)}>
                    {p}
                  </TuiBadge>
                ))}
              </div>
            </motion.div>
          </Link>
        ))}
      </div>
    </section>
  );
}
