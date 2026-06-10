'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { PrimitivesIsometricSvg } from '@/components/landing/svgs/primitives-isometric';
import { TuiBadge } from '@/components/tui/tui-badge';
import { HOVER_BG } from '@/lib/tui-theme';

interface Primitive {
  name: string;
  description: string;
  signature: string;
  color: 'cyan' | 'green';
  colSpan: 1 | 2;
  href: string;
}

const PRIMITIVES: Primitive[] = [
  // steps
  {
    name: 'llm',
    description: 'Call a language model',
    signature: '(params: ModelParams) => Step',
    color: 'green',
    colSpan: 2,
    href: '/docs/framework/steps/llm',
  },
  {
    name: 'tool',
    description: 'Invoke an external tool',
    signature: '(name, input, fn) => Step',
    color: 'green',
    colSpan: 1,
    href: '/docs/framework/steps/tool',
  },
  {
    name: 'run',
    description: 'Execute a pure function',
    signature: '(fn: (ctx) => T) => Step',
    color: 'green',
    colSpan: 1,
    href: '/docs/framework/steps/run',
  },
  // operators
  {
    name: 'spawn',
    description: 'Launch a child agent',
    signature: '(agentConfig) => Step',
    color: 'cyan',
    colSpan: 1,
    href: '/docs/framework/operators/spawn',
  },
  {
    name: 'fork',
    description: 'Parallel step execution',
    signature: '({ mode, paths }) => Step',
    color: 'cyan',
    colSpan: 1,
    href: '/docs/framework/operators/fork',
  },
  {
    name: 'branch',
    description: 'Conditional step selection',
    signature: '(route: (input) => Step) => Step',
    color: 'cyan',
    colSpan: 1,
    href: '/docs/framework/operators/branch',
  },
  {
    name: 'loop',
    description: 'Repeat steps until condition',
    signature: '(steps[], until) => Step',
    color: 'cyan',
    colSpan: 2,
    href: '/docs/framework/operators/loop-and-until',
  },
];

export function PrimitivesViz(): ReactNode {
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
          <SectionHeader
            label="core primitives"
            title="Meet the building blocks"
            margin="8px 0 12px"
          />
          <p
            style={{
              fontSize: '17px',
              color: 'var(--color-tui-secondary)',
              margin: '0 0 8px',
              lineHeight: 1.5,
            }}
          >
            A small set of composable primitives. Build any agent pattern by combining the pieces
            you need.
          </p>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--color-tui-muted)',
              margin: '0',
              lineHeight: 1.7,
            }}
          >
            Reasoning loops, parallel workloads, sub-agents — all of it falls out of these seven.
            The ReAct pattern is 15 lines. A task tree is 40. You can read both in under a minute.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PrimitivesIsometricSvg />
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '24px',
          alignItems: 'center',
          marginBottom: '12px',
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
        {(
          [
            {
              color: 'var(--color-tui-green)',
              label: 'steps',
            },
            {
              color: 'var(--color-tui-cyan)',
              label: 'operators',
            },
          ] as const
        ).map((item) => (
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

      <div className="tui-bento primitives-grid">
        {PRIMITIVES.map((primitive) => (
          <Link
            key={primitive.name}
            href={primitive.href}
            style={{
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <motion.div
              whileHover={HOVER_BG}
              data-col-span={primitive.colSpan}
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
                  alignItems: 'center',
                  gap: '10px',
                  marginBottom: '8px',
                }}
              >
                <TuiBadge color={primitive.color}>{primitive.name}</TuiBadge>
              </div>
              <p
                style={{
                  fontSize: '14px',
                  color: 'var(--color-tui-secondary)',
                  margin: '0 0 8px',
                }}
              >
                {primitive.description}
              </p>
              <code
                style={{
                  fontSize: '11px',
                  color: 'var(--color-tui-muted)',
                }}
              >
                {primitive.signature}
              </code>
            </motion.div>
          </Link>
        ))}
      </div>
    </section>
  );
}
