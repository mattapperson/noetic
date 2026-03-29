'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { MemoryIsometricSvg } from '@/components/landing/svgs/memory-isometric';

const LAYERS = [
  {
    name: 'Working Memory',
    description: 'Scratchpad for current turn',
    color: 'var(--color-tui-cyan)',
  },
  {
    name: 'Observational Memory',
    description: 'Auto-extracted facts from conversation',
    color: 'var(--color-tui-cyan)',
  },
  {
    name: 'Semantic Recall',
    description: 'Vector-indexed long-term storage',
    color: 'var(--color-tui-green)',
  },
  {
    name: 'Episodic Memory',
    description: 'Past conversation summaries',
    color: 'var(--color-tui-green)',
  },
  {
    name: 'Durable Task State',
    description: 'Persistent agent checkpoints',
    color: 'var(--color-tui-amber)',
  },
] as const;

export function MemorySystem(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '1280px',
        margin: '0 auto',
      }}
    >
      <div
        className="section-split"
        style={{
          marginBottom: '48px',
        }}
      >
        {/* Left: isometric SVG */}
        <div>
          <MemoryIsometricSvg />
        </div>

        {/* Right: copy only */}
        <div>
          <span
            style={{
              fontSize: '13px',
              color: 'var(--color-tui-muted)',
              letterSpacing: '0.1em',
            }}
          >
            {'// context management'}
          </span>
          <h2
            style={{
              fontSize: '38px',
              fontWeight: 700,
              margin: '8px 0 12px',
              textTransform: 'uppercase',
              letterSpacing: '-0.01em',
            }}
          >
            Unparalleled memory management
          </h2>
          <p
            style={{
              fontSize: '17px',
              color: 'var(--color-tui-secondary)',
              margin: '0 0 8px',
              lineHeight: 1.5,
            }}
          >
            Long multi-turn conversations without blowing up the context window.
          </p>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--color-tui-muted)',
              margin: '0',
              lineHeight: 1.7,
            }}
          >
            Working memory, observation extraction, vector recall, episode summaries, durable
            checkpoints. Let Noetic handle it or build your own. Token costs stay predictable as
            conversations grow.
          </p>
        </div>
      </div>

      {/* Layer list: full width below */}
      <div
        style={{
          background: 'var(--color-tui-surface)',
          border: '1px solid var(--color-tui-border)',
          padding: '16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: '4px',
        }}
      >
        {LAYERS.map((layer, i) => (
          <motion.div
            key={layer.name}
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
              border: '1px solid var(--color-tui-border)',
              padding: '12px 16px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: layer.color,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginBottom: '4px',
              }}
            >
              {layer.name}
            </div>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--color-tui-muted)',
              }}
            >
              {layer.description}
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
