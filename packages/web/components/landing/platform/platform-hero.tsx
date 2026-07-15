'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveDot } from '@/components/landing/code/live-dot';
import { TuiWindow } from '@/components/tui/tui-window';
import { CODE_PRE_STYLE } from '@/lib/tui-theme';

const STATUS_PILLS = [
  {
    state: 'running',
    label: 'durable sessions',
  },
  {
    state: 'running',
    label: 'gepa auto-improvement',
  },
  {
    state: 'idle',
    label: '10 chat connectors',
  },
  {
    state: 'idle',
    label: 'billing — if you want it',
  },
] as const;

const LIFECYCLE_LINES = [
  {
    prompt: true,
    text: '$ noetic agent create "support triage bot"',
  },
  {
    prompt: false,
    text: '✓ workflow compiled       llm → branch → tool',
  },
  {
    prompt: false,
    text: '✓ session started         microvm: warm (218ms)',
  },
  {
    prompt: false,
    text: '✓ traces captured         14 spans → node graph',
  },
  {
    prompt: false,
    text: '✓ eval suite passed       9/9 scorers',
  },
  {
    prompt: false,
    text: '✓ gepa iteration +6.2%    variant promoted',
  },
  {
    prompt: false,
    text: '✓ usage metered           plan: team',
  },
] as const;

export function PlatformHero(): ReactNode {
  return (
    <section className="code-hero-section">
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: '1180px',
          margin: 'auto',
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
            $ /noetic-platform
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
            Early Access
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
              the whole agent lifecycle.
              <span
                style={{
                  color: 'var(--color-tui-green)',
                  marginLeft: '8px',
                }}
              >
                one stack.
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
              PLATFORM
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
              The holistic agent platform. Build agents in TypeScript or plain language — then
              run, observe, prove, improve, and operate them without ever leaving the stack.
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
              Durable sessions in the cloud or on your own machines. Evals against real traces.
              GEPA-based self-improvement. Connectors, permissions, metering — even billing your
              own customers, if you want it.
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
                gap: '12px',
                flexWrap: 'wrap',
                marginTop: '12px',
              }}
            >
              <a
                href="https://app.noetic.tools"
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
                Open the dashboard →
              </a>
              <Link
                href="/docs"
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
                Read the docs
              </Link>
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
            <TuiWindow title="lifecycle.log">
              <pre style={CODE_PRE_STYLE}>
                {LIFECYCLE_LINES.map((line) => (
                  <span
                    key={line.text}
                    style={{
                      display: 'block',
                      color: line.prompt ? 'var(--color-tui-fg)' : 'var(--color-tui-secondary)',
                    }}
                  >
                    {line.prompt ? (
                      line.text
                    ) : (
                      <>
                        <span
                          style={{
                            color: 'var(--color-tui-green)',
                          }}
                        >
                          {line.text.slice(0, 1)}
                        </span>
                        {line.text.slice(1)}
                      </>
                    )}
                  </span>
                ))}
              </pre>
            </TuiWindow>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
