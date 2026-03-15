'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiBadge } from '@/components/tui/tui-badge';
import { HOVER_BG } from '@/lib/tui-theme';

interface Primitive {
  name: string;
  description: string;
  signature: string;
  color: 'cyan' | 'green' | 'amber';
  colSpan: 1 | 2;
}

const PRIMITIVES: Primitive[] = [
  {
    name: 'run',
    description: 'Execute a pure function',
    signature: '(fn: (ctx) => T) => Step',
    color: 'cyan',
    colSpan: 1,
  },
  {
    name: 'llm',
    description: 'Call a language model',
    signature: '(params: ModelParams) => Step',
    color: 'green',
    colSpan: 2,
  },
  {
    name: 'tool',
    description: 'Invoke an external tool',
    signature: '(name, input, fn) => Step',
    color: 'amber',
    colSpan: 1,
  },
  {
    name: 'branch',
    description: 'Conditional step selection',
    signature: '(condition, then, else) => Step',
    color: 'cyan',
    colSpan: 1,
  },
  {
    name: 'fork',
    description: 'Parallel step execution',
    signature: '(steps[], strategy) => Step',
    color: 'cyan',
    colSpan: 1,
  },
  {
    name: 'spawn',
    description: 'Launch a child agent',
    signature: '(agentConfig) => Step',
    color: 'green',
    colSpan: 1,
  },
  {
    name: 'loop',
    description: 'Repeat steps until condition',
    signature: '(steps[], until) => Step',
    color: 'amber',
    colSpan: 2,
  },
];

export function PrimitivesViz(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '960px',
        margin: '0 auto',
      }}
    >
      <SectionHeader label="primitives" title="Seven Primitives. Any Pattern." />

      <div className="tui-bento primitives-grid">
        {PRIMITIVES.map((primitive) => (
          <motion.div
            key={primitive.name}
            whileHover={HOVER_BG}
            data-col-span={primitive.colSpan}
            style={{
              background: 'var(--color-tui-surface)',
              padding: '20px',
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
                fontSize: '13px',
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
        ))}
      </div>
    </section>
  );
}
