'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

interface LayerTileProps {
  name: string;
  description: string;
  color: string;
  delay?: number;
}

export function LayerTile({ name, description, color, delay = 0 }: LayerTileProps): ReactNode {
  return (
    <motion.div
      initial={{
        opacity: 0,
        y: 10,
      }}
      whileInView={{
        opacity: 1,
        y: 0,
      }}
      transition={{
        delay,
        duration: 0.3,
      }}
      viewport={{
        once: true,
      }}
      style={{
        background: 'var(--color-tui-surface)',
        border: '1px solid var(--color-tui-border)',
        padding: '12px 16px',
      }}
    >
      <div
        style={{
          fontSize: '11px',
          fontWeight: 700,
          color,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: '4px',
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontSize: '12px',
          color: 'var(--color-tui-muted)',
        }}
      >
        {description}
      </div>
    </motion.div>
  );
}
