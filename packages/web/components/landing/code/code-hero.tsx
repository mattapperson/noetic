'use client';

import { motion, useScroll, useTransform } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CyclingCommand } from '@/components/landing/cycling-command';
import { TuiWindow } from '@/components/tui/tui-window';
import { highlightCode } from '@/lib/syntax-highlight';
import { CODE_PRE_STYLE, GITHUB_URL } from '@/lib/tui-theme';

const INSTALL_COMMANDS = [
  {
    prefix: '$ npm i -g ',
    package: '@noetic/cli',
  },
  {
    prefix: '$ bun add -g ',
    package: '@noetic/cli',
  },
  {
    prefix: '$ pnpm add -g ',
    package: '@noetic/cli',
  },
] as const;

const HERO_CODE = `$ noetic
│
├─ /plan add dark mode toggle
│    → planner:  claude-sonnet-4
│    → editor:   claude-opus-4
│    → reviewer: claude-haiku-4
│
└─ 10 memory layers active · 3 background agents running`;

const HIGHLIGHTED_HERO_CODE = highlightCode(HERO_CODE);

export function CodeHero(): ReactNode {
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
        inset: '64px 0px 0px',
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
          {'// the coding agent that keeps going'}
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
          NOETIC CODE
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
            fontSize: 'clamp(16px, 2.5vw, 18px)',
            color: 'var(--color-tui-fg)',
            maxWidth: '640px',
            marginBottom: '12px',
            lineHeight: 1.5,
          }}
        >
          A coding CLI with a real context manager and background teammates. Consistent quality on
          long tasks. Never hits a context limit.
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
            fontSize: 'clamp(13px, 2vw, 14px)',
            color: 'var(--color-tui-muted)',
            maxWidth: '640px',
            marginBottom: '40px',
            lineHeight: 1.7,
          }}
        >
          Ten memory layers working in concert. Detached agents in isolated worktrees. Per-phase
          model routing — not married to any provider.
        </motion.p>

        <CyclingCommand commands={INSTALL_COMMANDS} />

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
            Read the docs →
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
          }}
        >
          <TuiWindow title="~/my-project">
            <pre style={CODE_PRE_STYLE}>{HIGHLIGHTED_HERO_CODE}</pre>
          </TuiWindow>
        </motion.div>
      </motion.div>
    </section>
  );
}
