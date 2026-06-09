'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

interface InstallCommand {
  readonly manager: string;
  readonly verb: string;
  readonly pkg: string;
}

interface CyclingCommandProps {
  commands: ReadonlyArray<InstallCommand>;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 3e3;

export function CyclingCommand({
  commands,
  intervalMs = DEFAULT_INTERVAL_MS,
}: CyclingCommandProps): ReactNode {
  const [commandIndex, setCommandIndex] = useState(0);

  const cycleCommand = useCallback((): void => {
    setCommandIndex((prev) => (prev + 1) % commands.length);
  }, [
    commands.length,
  ]);

  useEffect(() => {
    if (commands.length <= 1) {
      return;
    }
    const interval = setInterval(cycleCommand, intervalMs);
    return (): void => clearInterval(interval);
  }, [
    cycleCommand,
    intervalMs,
    commands.length,
  ]);

  const current = commands[commandIndex];
  if (!current) {
    return null;
  }

  return (
    <motion.div
      initial={{
        opacity: 0,
      }}
      animate={{
        opacity: 1,
      }}
      transition={{
        delay: 0.6,
      }}
      style={{
        marginBottom: '40px',
        fontSize: '14px',
      }}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={commandIndex}
          initial={{
            opacity: 0,
            y: 8,
          }}
          animate={{
            opacity: 1,
            y: 0,
          }}
          exit={{
            opacity: 0,
            y: -8,
          }}
          transition={{
            duration: 0.15,
          }}
          style={{
            background: 'var(--color-tui-surface)',
            padding: '8px 16px',
            borderRadius: '4px',
            fontFamily: 'var(--font-mono)',
            border: '1px solid var(--color-tui-border)',
            display: 'inline-block',
          }}
        >
          <span
            style={{
              color: 'var(--color-tui-muted)',
            }}
          >
            {'$ '}
          </span>
          <span
            style={{
              color: 'var(--color-tui-amber)',
              fontWeight: 700,
            }}
          >
            {current.manager}
          </span>
          <span
            style={{
              color: 'var(--color-tui-muted)',
            }}
          >{` ${current.verb} `}</span>
          <span
            style={{
              color: 'var(--color-tui-fg)',
            }}
          >
            {current.pkg}
          </span>
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}
