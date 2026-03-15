'use client';

import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { TuiWindow } from '@/components/tui/tui-window';
import { CODE_PRE_STYLE, GITHUB_URL } from '@/lib/tui-theme';

const INSTALL_COMMANDS = [
  '$ bun add @orchid/core',
  '$ npm install @orchid/core',
  '$ pnpm add @orchid/core',
] as const;

const HERO_CODE = `import { react } from '@orchid/core';
import { InMemoryRuntime } from '@orchid/core';

const agent = react({
  model: 'gpt-4o',
  tools: [searchTool, calcTool],
  until: until.tokenBudget(4000),
});

const runtime = new InMemoryRuntime();
const result = await execute(agent, runtime);`;

const CYCLE_INTERVAL = 3e3;

export function Hero(): ReactNode {
  const [commandIndex, setCommandIndex] = useState(0);

  const cycleCommand = useCallback((): void => {
    setCommandIndex((prev) => (prev + 1) % INSTALL_COMMANDS.length);
  }, []);

  useEffect(() => {
    const interval = setInterval(cycleCommand, CYCLE_INTERVAL);
    return (): void => clearInterval(interval);
  }, [
    cycleCommand,
  ]);

  return (
    <section
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '120px 24px 80px',
        textAlign: 'center',
      }}
    >
      <motion.span
        initial={{
          opacity: 0,
        }}
        animate={{
          opacity: 1,
        }}
        style={{
          fontSize: '13px',
          color: 'var(--color-tui-green)',
          letterSpacing: '0.1em',
          marginBottom: '16px',
        }}
      >
        {'// agent framework'}
      </motion.span>

      <motion.h1
        initial={{
          opacity: 0,
          y: 20,
        }}
        animate={{
          opacity: 1,
          y: 0,
        }}
        transition={{
          delay: 0.2,
          duration: 0.5,
        }}
        className="tui-glow"
        style={{
          fontSize: 'clamp(48px, 10vw, 96px)',
          fontWeight: 800,
          color: 'var(--color-tui-green)',
          margin: '0 0 16px',
          lineHeight: 1,
        }}
      >
        ORCHID
      </motion.h1>

      <motion.p
        initial={{
          opacity: 0,
        }}
        animate={{
          opacity: 1,
        }}
        transition={{
          delay: 0.5,
        }}
        style={{
          fontSize: '16px',
          color: 'var(--color-tui-secondary)',
          maxWidth: '500px',
          margin: '0 0 32px',
          lineHeight: 1.6,
        }}
      >
        Primitives to build agents from scratch.
        <br />
        Patterns to start fast.
      </motion.p>

      <motion.div
        initial={{
          opacity: 0,
        }}
        animate={{
          opacity: 1,
        }}
        transition={{
          delay: 0.8,
        }}
        style={{
          marginBottom: '32px',
          height: '24px',
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
              color: 'var(--color-tui-muted)',
            }}
          >
            {INSTALL_COMMANDS[commandIndex]}
          </motion.span>
        </AnimatePresence>
      </motion.div>

      <motion.div
        initial={{
          opacity: 0,
        }}
        animate={{
          opacity: 1,
        }}
        transition={{
          delay: 1,
        }}
        style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '48px',
        }}
      >
        <Link
          href="/docs"
          style={{
            padding: '10px 24px',
            background: 'var(--color-tui-green)',
            color: 'var(--color-tui-bg)',
            fontSize: '13px',
            fontWeight: 700,
            textDecoration: 'none',
            borderRadius: '4px',
            letterSpacing: '0.05em',
          }}
        >
          Read the docs
        </Link>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '10px 24px',
            border: '1px solid var(--color-tui-border)',
            color: 'var(--color-tui-fg)',
            fontSize: '13px',
            fontWeight: 600,
            textDecoration: 'none',
            borderRadius: '4px',
            letterSpacing: '0.05em',
          }}
        >
          View on GitHub
        </a>
      </motion.div>

      <motion.div
        initial={{
          opacity: 0,
          y: 20,
        }}
        animate={{
          opacity: 1,
          y: 0,
        }}
        transition={{
          delay: 1.5,
          duration: 0.5,
        }}
        style={{
          width: '100%',
          maxWidth: '640px',
        }}
      >
        <TuiWindow title="react-agent.ts">
          <pre style={CODE_PRE_STYLE}>{HERO_CODE}</pre>
        </TuiWindow>
      </motion.div>
    </section>
  );
}
