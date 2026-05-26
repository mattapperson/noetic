'use client';

import type { ReactNode } from 'react';
import { LayerTile } from '@/components/landing/layer-tile';
import { LegendRow } from '@/components/landing/legend-row';
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

const LEGEND = [
  {
    color: 'var(--color-tui-cyan)',
    label: 'working layers',
  },
  {
    color: 'var(--color-tui-green)',
    label: 'retrieval layers',
  },
  {
    color: 'var(--color-tui-amber)',
    label: 'persistence',
  },
] as const;

export function MemorySystem(): ReactNode {
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
        {/* Copy - appears first in DOM for mobile, reordered on desktop */}
        <div className="memory-content">
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

        {/* SVG - appears second in DOM for mobile, reordered on desktop */}
        <div className="memory-visual">
          <MemoryIsometricSvg />
        </div>
      </div>

      <LegendRow items={LEGEND} />

      <div
        className="memory-layers-grid"
        style={{
          display: 'grid',
          gap: '4px',
        }}
      >
        {LAYERS.map((layer, i) => (
          <LayerTile
            key={layer.name}
            name={layer.name}
            description={layer.description}
            color={layer.color}
            delay={i * 0.08}
          />
        ))}
      </div>
    </section>
  );
}
