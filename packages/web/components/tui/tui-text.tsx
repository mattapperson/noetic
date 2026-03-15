'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useId } from 'react';

interface TuiTextProps {
  text: string;
  delay?: number;
  speed?: number;
  className?: string;
  showCursor?: boolean;
}

export function TuiText({
  text,
  delay = 0,
  speed = 0.03,
  className,
  showCursor = true,
}: TuiTextProps): ReactNode {
  const id = useId();
  const characters = text.split('');

  return (
    <span className={className}>
      {characters.map((char, i) => (
        <motion.span
          key={`${id}-${char}-${i.toString()}`}
          initial={{
            opacity: 0,
          }}
          animate={{
            opacity: 1,
          }}
          transition={{
            delay: delay + i * speed,
            duration: 0,
          }}
        >
          {char}
        </motion.span>
      ))}
      {showCursor && (
        <motion.span
          className="tui-cursor"
          initial={{
            opacity: 0,
          }}
          animate={{
            opacity: 1,
          }}
          transition={{
            delay: delay + characters.length * speed,
          }}
          style={{
            color: 'var(--color-tui-green)',
          }}
        >
          _
        </motion.span>
      )}
    </span>
  );
}
