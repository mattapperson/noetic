'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiFrame } from '@/components/tui/tui-frame';

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
        maxWidth: '640px',
        margin: '0 auto',
      }}
    >
      <SectionHeader label="memory layers" title="Layered Memory System" />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}
      >
        {LAYERS.map((layer, i) => (
          <motion.div
            key={layer.name}
            initial={{
              opacity: 0,
              x: -20,
            }}
            whileInView={{
              opacity: 1,
              x: 0,
            }}
            transition={{
              delay: i * 0.1,
              duration: 0.3,
            }}
            viewport={{
              once: true,
            }}
          >
            <TuiFrame title={layer.name}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    fontSize: '13px',
                    color: 'var(--color-tui-secondary)',
                  }}
                >
                  {layer.description}
                </span>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: layer.color,
                  }}
                />
              </div>
            </TuiFrame>
          </motion.div>
        ))}
      </div>

      <motion.div
        initial={{
          opacity: 0,
        }}
        whileInView={{
          opacity: 1,
        }}
        transition={{
          delay: 0.6,
        }}
        viewport={{
          once: true,
        }}
        style={{
          textAlign: 'center',
          margin: '24px 0 0',
          padding: '16px',
          border: '1px solid var(--color-tui-border)',
          background: 'var(--color-tui-surface)',
          fontSize: '12px',
          color: 'var(--color-tui-muted)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {'assembleView() → merged context → LLM'}
      </motion.div>
    </section>
  );
}
