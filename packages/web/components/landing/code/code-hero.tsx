'use client';

import { motion, useScroll, useTransform } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveDot } from '@/components/landing/code/live-dot';
import { CyclingCommand } from '@/components/landing/cycling-command';
import { highlightCode } from '@/lib/syntax-highlight';
import { GITHUB_URL } from '@/lib/tui-theme';

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

const HERO_CODE = `noetic@host:~/repo $ noetic /plan add dark-mode toggle
  ├─ planner    claude-sonnet-4         queued
  ├─ editor     claude-opus-4           routing
  └─ reviewer   claude-haiku-4          standby

[memory] 10 layers active   working 1842/2400 · semantic 4021/8000
[team]   3 detached agents   researcher · refactor-bot · test-writer
[budget] 9756/17400 tokens (56%)   no context pressure

> _`;

const HIGHLIGHTED_HERO_CODE = highlightCode(HERO_CODE);

const STATUS_PILLS = [
  {
    state: 'running',
    label: '10 memory layers',
  },
  {
    state: 'running',
    label: '3 background agents',
  },
  {
    state: 'idle',
    label: 'multi-model routing',
  },
] as const;

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
        padding: '24px 24px 48px',
        textAlign: 'left',
        zIndex: 0,
        margin: 'auto',
        height: '100vh',
      }}
    >
      <motion.div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: '1180px',
          margin: 'auto',
          opacity,
          pointerEvents,
        }}
      >
        <motion.div
          initial={{
            opacity: 0,
          }}
          animate={{
            opacity: 1,
          }}
          transition={{
            duration: 0.4,
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            paddingBottom: '12px',
            borderBottom: '1px solid var(--color-tui-border)',
            marginBottom: '32px',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              letterSpacing: '0.2em',
              color: 'var(--color-tui-muted)',
              textTransform: 'uppercase',
            }}
          >
            $ /noetic-code
          </span>
          <span
            style={{
              fontSize: '11px',
              letterSpacing: '0.16em',
              color: 'var(--color-tui-muted)',
              textTransform: 'uppercase',
            }}
          >
            v0.1 — public preview
          </span>
        </motion.div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: '56px',
            alignItems: 'start',
          }}
          className="hero-grid"
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
            }}
          >
            <motion.span
              initial={{
                opacity: 0,
              }}
              animate={{
                opacity: 1,
              }}
              transition={{
                delay: 0.1,
              }}
              style={{
                display: 'inline-block',
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                fontSize: '20px',
                color: 'var(--color-tui-secondary)',
                lineHeight: 1,
              }}
            >
              the coding agent that
              <span
                style={{
                  color: 'var(--color-tui-green)',
                  marginLeft: '8px',
                }}
              >
                keeps going.
              </span>
            </motion.span>

            <motion.h1
              initial={{
                opacity: 0,
                y: 12,
              }}
              animate={{
                opacity: 1,
                y: 0,
              }}
              transition={{
                delay: 0.18,
                duration: 0.5,
              }}
              className="tui-phosphor"
              style={{
                fontSize: 'clamp(56px, 9vw, 132px)',
                fontWeight: 800,
                color: 'var(--color-tui-green)',
                margin: 0,
                lineHeight: 0.92,
                letterSpacing: '-0.04em',
              }}
            >
              NOETIC
              <br />
              CODE
            </motion.h1>

            <motion.p
              initial={{
                opacity: 0,
              }}
              animate={{
                opacity: 1,
              }}
              transition={{
                delay: 0.32,
              }}
              style={{
                fontSize: '15px',
                color: 'var(--color-tui-secondary)',
                maxWidth: '520px',
                marginTop: '8px',
                lineHeight: 1.65,
              }}
            >
              A coding CLI with a real context manager and background teammates. Quality holds on
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
                delay: 0.42,
              }}
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-muted)',
                maxWidth: '520px',
                lineHeight: 1.7,
              }}
            >
              Ten memory layers in concert. Detached agents in isolated worktrees. Per-phase model
              routing — not married to any provider.
            </motion.p>

            <motion.div
              initial={{
                opacity: 0,
              }}
              animate={{
                opacity: 1,
              }}
              transition={{
                delay: 0.55,
              }}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
                marginTop: '4px',
              }}
            >
              {STATUS_PILLS.map((pill) => (
                <span
                  key={pill.label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px 6px 6px',
                    border: '1px solid var(--color-tui-border)',
                    background: 'var(--color-tui-surface)',
                    borderRadius: '999px',
                    fontSize: '11px',
                    color: 'var(--color-tui-secondary)',
                    letterSpacing: '0.04em',
                  }}
                >
                  <LiveDot state={pill.state} />
                  {pill.label}
                </span>
              ))}
            </motion.div>

            <motion.div
              initial={{
                opacity: 0,
              }}
              animate={{
                opacity: 1,
              }}
              transition={{
                delay: 0.7,
              }}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '12px',
                alignItems: 'center',
                marginTop: '12px',
              }}
            >
              <CyclingCommand commands={INSTALL_COMMANDS} />
            </motion.div>

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
                display: 'flex',
                gap: '12px',
                flexWrap: 'wrap',
              }}
            >
              <Link
                href="/docs"
                style={{
                  padding: '11px 22px',
                  background: 'var(--color-tui-green)',
                  color: 'var(--color-tui-bg)',
                  fontSize: '13px',
                  fontWeight: 700,
                  textDecoration: 'none',
                  borderRadius: '4px',
                  letterSpacing: '0.05em',
                  boxShadow: '0 0 24px rgba(57, 255, 20, 0.25)',
                }}
              >
                Read the docs →
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '11px 22px',
                  border: '1px solid var(--color-tui-border-bright)',
                  color: 'var(--color-tui-fg)',
                  fontSize: '13px',
                  fontWeight: 600,
                  textDecoration: 'none',
                  borderRadius: '4px',
                  letterSpacing: '0.05em',
                  background: 'transparent',
                }}
              >
                {'GitHub ★'}
              </a>
            </motion.div>
          </div>

          <motion.div
            initial={{
              opacity: 0,
              scale: 0.98,
            }}
            animate={{
              opacity: 1,
              scale: 1,
            }}
            transition={{
              delay: 0.6,
              duration: 0.6,
            }}
            style={{
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '-1px',
                left: '24px',
                right: '24px',
                height: '1px',
                background:
                  'linear-gradient(90deg, transparent, var(--color-tui-green) 50%, transparent)',
                opacity: 0.6,
              }}
            />
            <div
              style={{
                background: 'var(--color-tui-bg-deep)',
                border: '1px solid var(--color-tui-border-bright)',
                borderRadius: '6px',
                overflow: 'hidden',
                boxShadow:
                  '0 0 0 1px rgba(57, 255, 20, 0.06), 0 24px 80px -32px rgba(57, 255, 20, 0.25), 0 8px 32px rgba(0, 0, 0, 0.6)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--color-tui-border)',
                  background:
                    'linear-gradient(180deg, var(--color-tui-surface-2) 0%, var(--color-tui-bg-deep) 100%)',
                }}
              >
                <LiveDot state="running" size={6} />
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-tui-secondary)',
                    letterSpacing: '0.06em',
                  }}
                >
                  ~/my-project — noetic
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '10px',
                    color: 'var(--color-tui-muted)',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  detached · 47m
                </span>
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '20px 22px',
                  fontSize: '12.5px',
                  lineHeight: 1.75,
                  color: 'var(--color-tui-secondary)',
                  fontFamily: 'var(--font-mono), monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {HIGHLIGHTED_HERO_CODE}
                <span
                  className="tui-cursor"
                  style={{
                    color: 'var(--color-tui-green)',
                    marginLeft: '2px',
                  }}
                >
                  █
                </span>
              </pre>
            </div>
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}
