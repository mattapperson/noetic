'use client';

import { motion, useScroll, useTransform } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveDot } from '@/components/landing/code/live-dot';
import { NoeticTuiPreview } from '@/components/landing/code/noetic-tui-preview';
import { CyclingCommand } from '@/components/landing/cycling-command';
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
    <section className="code-hero-section">
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
              padding: '4px 10px',
              background: 'rgba(245, 158, 11, 0.15)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              borderRadius: '4px',
              color: 'rgb(245, 158, 11)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Coming Soon
          </span>
        </motion.div>

        <div className="hero-grid">
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
                fontSize: 'clamp(44px, 11vw, 132px)',
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
            <NoeticTuiPreview />
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}
