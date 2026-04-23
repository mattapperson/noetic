'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { SectionBody } from '@/components/landing/section-body';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiBadge } from '@/components/tui/tui-badge';
import { TuiReadout } from '@/components/tui/tui-readout';

interface AgentCard {
  name: string;
  lede: string;
  detail: string;
  signal: string;
}

const AGENTS: AgentCard[] = [
  {
    name: 'Spawn',
    lede: 'Detached child agents on a fresh thread.',
    detail:
      'Spin up a child with its own context window, let it work, receive the result. Nothing the child did pollutes the parent session.',
    signal: 'fresh threadId',
  },
  {
    name: 'Named Teammates',
    lede: 'Long-running background workers with an inbox.',
    detail:
      'Give an agent a name and it becomes addressable. Send messages, check status, pull results when you want them. They work while you work.',
    signal: 'sendMessage() inbox',
  },
  {
    name: 'Worktree Isolation',
    lede: 'Each agent gets its own git worktree.',
    detail:
      'Parallelize without agents stomping on each other’s edits. Merge cleanly when they’re done. No shared working tree, no shared mistakes.',
    signal: 'isolation: worktree',
  },
];

export function CodeBackgroundAgents(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        margin: '0 auto',
      }}
    >
      <div
        className="section-split"
        style={{
          marginBottom: '48px',
        }}
      >
        <div>
          <SectionHeader
            label="background agents"
            title="Work that keeps going"
            margin="8px 0 12px"
          />
          <SectionBody
            lede="A long task should not crash into a context limit at hour three."
            detail="Background agents run detached, on fresh threads, in isolated worktrees. Hand off the heavy lift to a teammate and keep steering from the main session. Quality holds because no single thread ever gets bloated."
          />
        </div>

        <TuiReadout>
          <div
            style={{
              color: 'var(--color-tui-green)',
            }}
          >
            {'$ noetic /team'}
          </div>
          <div>{'▸ researcher    running   3h 12m   ctx 41%'}</div>
          <div>{'▸ refactor-bot  running   0h 47m   ctx 22%'}</div>
          <div>{'▸ test-writer   idle      —        inbox: 2'}</div>
          <div>{'▸ reviewer      done      18m 04s  ctx 58%'}</div>
          <div
            style={{
              color: 'var(--color-tui-muted)',
              marginTop: '4px',
            }}
          >
            {'main session unaffected · 0 context pressure'}
          </div>
        </TuiReadout>
      </div>

      <div
        className="patterns-grid"
        style={{
          display: 'grid',
          gap: '4px',
        }}
      >
        {AGENTS.map((agent, i) => (
          <motion.div
            key={agent.name}
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
              padding: '32px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <span
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: 'var(--color-tui-fg)',
                  letterSpacing: '-0.01em',
                }}
              >
                {agent.name}
              </span>
              <TuiBadge color="cyan">{agent.signal}</TuiBadge>
            </div>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--color-tui-secondary)',
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {agent.lede}
            </p>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-muted)',
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              {agent.detail}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
