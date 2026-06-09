'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { LiveDot } from '@/components/landing/code/live-dot';

type AgentStatus = 'running' | 'idle' | 'done';

interface RosterRow {
  name: string;
  task: string;
  status: AgentStatus;
  uptime: string;
  context: string;
}

interface CapabilityCard {
  number: string;
  name: string;
  lede: string;
  detail: string;
  signal: string;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  idle: 'idle',
  done: 'done',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  running: 'var(--color-tui-green)',
  idle: 'var(--color-tui-amber)',
  done: 'var(--color-tui-cyan)',
};

const ROSTER: RosterRow[] = [
  {
    name: 'researcher',
    task: 'pull related issues + RFCs',
    status: 'running',
    uptime: '3h 12m',
    context: 'ctx 41%',
  },
  {
    name: 'refactor-bot',
    task: 'extract common middleware',
    status: 'running',
    uptime: '0h 47m',
    context: 'ctx 22%',
  },
  {
    name: 'test-writer',
    task: 'inbox waiting · 2 messages',
    status: 'idle',
    uptime: '—',
    context: 'inbox: 2',
  },
  {
    name: 'reviewer',
    task: 'finished diff review on #482',
    status: 'done',
    uptime: '18m 04s',
    context: 'ctx 58%',
  },
];

const CAPABILITIES: CapabilityCard[] = [
  {
    number: '01',
    name: 'Spawn',
    lede: 'Detached child agents on a fresh thread.',
    detail:
      'Spin up a child with its own context window, let it work, receive the result. Nothing the child did pollutes the parent session.',
    signal: 'fresh threadId',
  },
  {
    number: '02',
    name: 'Named Teammates',
    lede: 'Long-running background workers with an inbox.',
    detail:
      'Give an agent a name and it becomes addressable. Send messages, check status, pull results when you want them. They work while you work.',
    signal: 'sendMessage() inbox',
  },
  {
    number: '03',
    name: 'Worktree Isolation',
    lede: 'Each agent gets its own git worktree.',
    detail:
      'Parallelize without agents stomping on each other’s edits. Merge cleanly when they’re done. No shared working tree, no shared mistakes.',
    signal: 'isolation: worktree',
  },
];

export function CodeBackgroundAgents(): ReactNode {
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
        <span className="code-section-eyebrow">{'03 / background agents'}</span>
        <h2 className="code-display-headline">
          Work that <em>keeps going.</em>
        </h2>
        <p
          style={{
            fontSize: '15px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.65,
          }}
        >
          A long task should not crash into a context limit at hour three. Hand off the heavy lift
          to a teammate and keep steering from the main session. Quality holds because no single
          thread ever gets bloated.
        </p>
      </div>

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
          marginBottom: '32px',
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
          <span>$ noetic /team</span>
          <span
            style={{
              marginLeft: 'auto',
              color: 'var(--color-tui-muted)',
              fontSize: '10px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            main session — 0 ctx pressure
          </span>
        </div>

        <div>
          <div
            className="code-roster-row code-roster-header"
            style={{
              fontSize: '10px',
              color: 'var(--color-tui-muted)',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              borderBottom: '1px solid var(--color-tui-border)',
            }}
          >
            <span />
            <span>agent / task</span>
            <span className="code-roster-meta">status</span>
            <span className="code-roster-meta">uptime</span>
            <span className="code-roster-meta">context</span>
          </div>

          {ROSTER.map((row, i) => (
            <motion.div
              key={row.name}
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
              className="code-roster-row"
            >
              <LiveDot state={row.status} />
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    color: 'var(--color-tui-fg)',
                    fontWeight: 700,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.name}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--color-tui-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.task}
                </span>
              </div>
              <span
                className="code-roster-meta"
                style={{
                  color: STATUS_COLOR[row.status],
                  fontSize: '11px',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                }}
              >
                {STATUS_LABEL[row.status]}
              </span>
              <span
                className="code-roster-meta"
                style={{
                  color: 'var(--color-tui-secondary)',
                }}
              >
                {row.uptime}
              </span>
              <span
                className="code-roster-meta"
                style={{
                  color: 'var(--color-tui-muted)',
                  fontSize: '11px',
                }}
              >
                {row.context}
              </span>
            </motion.div>
          ))}
        </div>
      </motion.div>

      <div
        className="patterns-grid"
        style={{
          display: 'grid',
          gap: '4px',
        }}
      >
        {CAPABILITIES.map((cap, i) => (
          <motion.div
            key={cap.name}
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
              {cap.number}
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
                {cap.name}
              </div>
              <code
                style={{
                  fontSize: '11px',
                  color: 'var(--color-tui-cyan)',
                  letterSpacing: '0.04em',
                }}
              >
                {cap.signal}
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
              {cap.lede}
            </p>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-muted)',
                margin: 0,
                lineHeight: 1.65,
              }}
            >
              {cap.detail}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
