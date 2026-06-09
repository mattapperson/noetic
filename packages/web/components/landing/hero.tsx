'use client';

import { motion, useScroll, useTransform } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ValueProps } from '@/components/landing/value-props';
import { TuiWindow } from '@/components/tui/tui-window';
import { highlightCode } from '@/lib/syntax-highlight';
import { CODE_PRE_STYLE, GITHUB_URL } from '@/lib/tui-theme';

const HERO_CODE = `import { AgentHarness, react } from '@noetic-tools/core';

const agent = react({
  model: 'gpt-4o',
  tools: [searchTool, calcTool],
  maxSteps: 10,
});

const harness = new AgentHarness({
  name: 'researcher',
  initialStep: agent,
  params: {},
});

await harness.execute('Find recent AI news');
const { text } = await harness.getAgentResponse();`;

const HIGHLIGHTED_HERO_CODE = highlightCode(HERO_CODE);

export function Hero(): ReactNode {
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

  return (
    <section
      style={{
        position: 'sticky',
        inset: '102px 0px 0px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '24px',
        textAlign: 'center',
        zIndex: 0,
        margin: 'auto',
        height: '100vh',
      }}
    >
      <motion.div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          maxWidth: '1200px',
          margin: 'auto',
          opacity,
          pointerEvents,
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
            fontSize: 'clamp(36px, 8vw, 96px)',
            fontWeight: 800,
            color: 'var(--color-tui-green)',
            marginBottom: '16px',
            lineHeight: 1.1,
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
            fontSize: 'clamp(18px, 2.6vw, 22px)',
            fontWeight: 600,
            color: 'var(--color-tui-fg)',
            maxWidth: '620px',
            marginBottom: '14px',
            lineHeight: 1.4,
          }}
        >
          Build AI agents you&rsquo;d actually trust in production.
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
            fontSize: 'clamp(13px, 2vw, 15px)',
            color: 'var(--color-tui-secondary)',
            maxWidth: '620px',
            marginBottom: '32px',
            lineHeight: 1.6,
          }}
        >
          Noetic gives you composable TypeScript primitives, memory that keeps token costs flat, and
          evals that catch regressions before users do.
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
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            justifyContent: 'center',
            fontSize: '14px',
          }}
        >
          <span
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
                color: 'var(--color-tui-fg)',
              }}
            >
              bun add @noetic-tools/core
            </span>
          </span>
          <span
            style={{
              fontSize: '12px',
              color: 'var(--color-tui-muted)',
            }}
          >
            (npm · pnpm)
          </span>
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
            flexWrap: 'wrap',
            justifyContent: 'center',
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
          }}
          animate={{
            opacity: 1,
          }}
          transition={{
            delay: 0.85,
          }}
          style={{
            width: '100%',
            marginBottom: '40px',
          }}
        >
          <ValueProps />
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
          }}
        >
          <TuiWindow title="react-agent.ts">
            <pre style={CODE_PRE_STYLE}>{HIGHLIGHTED_HERO_CODE}</pre>
          </TuiWindow>
        </motion.div>
      </motion.div>
    </section>
  );
}
