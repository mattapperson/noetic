'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { LiveDot } from '@/components/landing/code/live-dot';
import { PhoneShot } from '@/components/landing/phone-shot';

interface SurfaceCard {
  number: string;
  name: string;
  lede: string;
  detail: string;
  signal: string;
}

const SURFACES: SurfaceCard[] = [
  {
    number: '01',
    name: 'Terminal',
    lede: 'The full TUI you already know.',
    detail:
      'Streamed diffs, plan mode, background teammates, a kanban task board. Install with brew, apt, npm, scoop, or winget.',
    signal: '$ noetic',
  },
  {
    number: '02',
    name: 'iPhone & iPad',
    lede: 'The same session, in your pocket.',
    detail:
      'A native app — not a webview. Read diffs with real syntax highlighting, answer the agent’s questions by voice, queue up the next task from anywhere.',
    signal: 'ios · native swift',
  },
  {
    number: '03',
    name: 'Mac',
    lede: 'A desktop app that can lend a hand.',
    detail:
      'Chat in a native window, or flip it around: serve your Mac’s shell and filesystem as the agent’s computer while you watch from your phone.',
    signal: 'macos · native swift',
  },
  {
    number: '04',
    name: 'Web',
    lede: 'Every session in the browser.',
    detail:
      'The dashboard shows the same live thread, the same queue, the same context panel. Nothing to install when you’re on someone else’s machine.',
    signal: 'app.noetic.tools',
  },
];

interface HandoffStep {
  time: string;
  device: string;
  line: string;
  color: string;
}

const HANDOFF: HandoffStep[] = [
  {
    time: '17:42',
    device: 'terminal',
    line: '"migrate the billing service off stripe v1" — agent starts in a cloud VM',
    color: 'var(--color-tui-green)',
  },
  {
    time: '17:58',
    device: 'terminal',
    line: 'laptop closed. the turn keeps running server-side',
    color: 'var(--color-tui-green)',
  },
  {
    time: '18:20',
    device: 'iphone',
    line: 'progress check on the train. queue a note: "keep the old webhooks"',
    color: 'var(--color-tui-cyan)',
  },
  {
    time: '21:04',
    device: 'iphone',
    line: 'agent asks which retry policy — answer from the couch',
    color: 'var(--color-tui-cyan)',
  },
  {
    time: '08:15',
    device: 'terminal',
    line: 'back at the desk. review the diff, run the tests, merge',
    color: 'var(--color-tui-green)',
  },
];

export function CodeEverywhere(): ReactNode {
  return (
    <section className="code-section">
      <div
        style={{
          display: 'grid',
          gap: '16px',
          marginBottom: '40px',
          maxWidth: '780px',
        }}
      >
        <span className="code-section-eyebrow">{'05 / every screen'}</span>
        <h2 className="code-display-headline">
          Not just a CLI. <em>One agent, everywhere.</em>
        </h2>
        <p
          style={{
            fontSize: '15px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.65,
          }}
        >
          Sessions live in the cloud, not in a terminal process. The same conversation — the same
          diffs, the same queue, the same memory — is open in your terminal, on your Mac, on your
          phone, and on the web, synced live over one WebSocket stream.
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '28px',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          marginBottom: '32px',
        }}
      >
      <motion.div
        initial={{
          opacity: 0,
          y: 12,
        }}
        whileInView={{
          opacity: 1,
          y: 0,
        }}
        transition={{
          duration: 0.5,
        }}
        viewport={{
          once: true,
        }}
        style={{
          background: 'var(--color-tui-bg-deep)',
          border: '1px solid var(--color-tui-border-bright)',
          borderRadius: '6px',
          overflow: 'hidden',
          flex: '1 1 480px',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-tui-border)',
            background: 'var(--color-tui-surface-2)',
            fontSize: '11px',
            color: 'var(--color-tui-secondary)',
            letterSpacing: '0.06em',
          }}
        >
          <LiveDot state="running" size={6} />
          <span>session: billing-migration</span>
          <span
            style={{
              marginLeft: 'auto',
              color: 'var(--color-tui-muted)',
              fontSize: '10px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            one durable session — three devices
          </span>
        </div>

        <div
          style={{
            position: 'relative',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '21px',
              top: '18px',
              bottom: '18px',
              width: '1px',
              background: 'var(--color-tui-border-bright)',
            }}
          />
          {HANDOFF.map((step, i) => (
            <motion.div
              key={step.time}
              initial={{
                opacity: 0,
              }}
              whileInView={{
                opacity: 1,
              }}
              transition={{
                delay: i * 0.06,
                duration: 0.3,
              }}
              viewport={{
                once: true,
              }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '14px',
                padding: '12px 16px 12px 38px',
                borderBottom:
                  i === HANDOFF.length - 1 ? 'none' : '1px solid var(--color-tui-border)',
                fontSize: '13px',
                position: 'relative',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: '18px',
                  top: '17px',
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: step.color,
                }}
              />
              <span
                style={{
                  color: 'var(--color-tui-muted)',
                  fontSize: '11px',
                  flexShrink: 0,
                }}
              >
                {step.time}
              </span>
              <span
                style={{
                  color: 'var(--color-tui-cyan)',
                  fontSize: '11px',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  width: '72px',
                  flexShrink: 0,
                }}
              >
                {step.device}
              </span>
              <span
                style={{
                  color: 'var(--color-tui-secondary)',
                  lineHeight: 1.5,
                }}
              >
                {step.line}
              </span>
            </motion.div>
          ))}
        </div>
      </motion.div>

        <PhoneShot
          src="/screenshots/ios-new-chat.png"
          alt="Noetic iOS app — starting a new chat with project and agent pickers"
          caption="the ios app, same session"
        />
      </div>

      <div
        className="patterns-grid"
        style={{
          display: 'grid',
          gap: '4px',
          marginBottom: '32px',
        }}
      >
        {SURFACES.map((surface, i) => (
          <motion.div
            key={surface.name}
            initial={{
              opacity: 0,
              y: 10,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            transition={{
              delay: i * 0.08,
              duration: 0.3,
            }}
            viewport={{
              once: true,
            }}
            style={{
              background: 'var(--color-tui-surface)',
              border: '1px solid var(--color-tui-border)',
              padding: '32px 28px 28px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              position: 'relative',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                fontSize: '38px',
                color: 'var(--color-tui-faint)',
                lineHeight: 1,
              }}
            >
              {surface.number}
            </span>
            <div>
              <div
                style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  color: 'var(--color-tui-fg)',
                  letterSpacing: '-0.01em',
                  marginBottom: '4px',
                }}
              >
                {surface.name}
              </div>
              <code
                style={{
                  fontSize: '11px',
                  color: 'var(--color-tui-cyan)',
                  letterSpacing: '0.04em',
                }}
              >
                {surface.signal}
              </code>
            </div>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--color-tui-secondary)',
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {surface.lede}
            </p>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-muted)',
                margin: 0,
                lineHeight: 1.65,
              }}
            >
              {surface.detail}
            </p>
          </motion.div>
        ))}
      </div>

      <p
        style={{
          padding: '14px 16px',
          border: '1px solid var(--color-tui-border)',
          fontSize: '13px',
          color: 'var(--color-tui-secondary)',
          background: 'var(--color-tui-surface)',
          margin: 0,
          lineHeight: 1.6,
        }}
      >
        The computer is your choice too: each session gets a persistent Linux microVM in the cloud
        — or point it at your own machine with{' '}
        <code
          style={{
            color: 'var(--color-tui-cyan)',
          }}
        >
          noetic project host
        </code>{' '}
        and the agent’s shell and files live on hardware you control.
      </p>
    </section>
  );
}
