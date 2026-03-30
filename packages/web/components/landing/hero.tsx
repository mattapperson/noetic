'use client';

import { AnimatePresence, motion, useScroll, useTransform } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TuiWindow } from '@/components/tui/tui-window';
import { CODE_PRE_STYLE, GITHUB_URL } from '@/lib/tui-theme';

const INSTALL_COMMANDS = [
  '$ bun add @noetic/core',
  '$ npm install @noetic/core',
  '$ pnpm add @noetic/core',
] as const;

const HERO_CODE = `import { react } from '@noetic/core';
import { InMemoryRuntime } from '@noetic/core';

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
  const containerRef = useRef<HTMLElement>(null);

  const { scrollY } = useScroll();
  const opacity = useTransform(
    scrollY,
    [
      0,
      800,
    ],
    [
      1,
      0,
    ],
  );
  const pointerEvents = useTransform(
    scrollY,
    [
      0,
      400,
    ],
    [
      'auto',
      'none',
    ],
  );

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
      ref={containerRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '120px 24px 80px',
        textAlign: 'center',
        zIndex: 0,
      }}
    >
      <motion.div
        style={{
          opacity,
          pointerEvents,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
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
          {'// constrain the agent, not the intelligence'}
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
            delay: 0.15,
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
          NOETIC
        </motion.h1>

        <motion.p
          initial={{
            opacity: 0,
          }}
          animate={{
            opacity: 1,
          }}
          transition={{
            delay: 0.3,
          }}
          style={{
            fontSize: '18px',
            color: 'var(--color-tui-fg)',
            maxWidth: '560px',
            margin: '0 0 12px',
            lineHeight: 1.5,
          }}
        >
          Composable primitives. Clean code from 10 lines to 10,000.
        </motion.p>

        <motion.p
          initial={{
            opacity: 0,
          }}
          animate={{
            opacity: 1,
          }}
          transition={{
            delay: 0.45,
          }}
          style={{
            fontSize: '14px',
            color: 'var(--color-tui-muted)',
            maxWidth: '560px',
            margin: '0 0 32px',
            lineHeight: 1.7,
          }}
        >
          Start with pre-built patterns — ReAct, task trees, dual-agent loops. Or compose your own.
          Reactive memory keeps context windows manageable automatically.
        </motion.p>

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
            delay: 0.75,
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
            Build your first agent →
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '10px 24px',
              border: '1px solid var(--color-tui-green)',
              color: 'var(--color-tui-green)',
              fontSize: '13px',
              fontWeight: 600,
              textDecoration: 'none',
              borderRadius: '4px',
              letterSpacing: '0.05em',
            }}
          >
            {'GitHub ★'}
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
            delay: 0.9,
            duration: 0.5,
          }}
          style={{
            width: '100%',
            maxWidth: '640px',
            textAlign: 'left',
          }}
        >
          <TuiWindow title="react-agent.ts">
            <pre style={CODE_PRE_STYLE}>{HERO_CODE}</pre>
          </TuiWindow>
        </motion.div>
      </motion.div>
    </section>
  );
}
