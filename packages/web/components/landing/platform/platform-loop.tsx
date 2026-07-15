'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

interface LoopStage {
  number: string;
  name: string;
  lede: string;
  detail: string;
  signal: string;
}

const STAGES: LoopStage[] = [
  {
    number: '01',
    name: 'Build',
    lede: 'TypeScript primitives or plain language.',
    detail:
      'The same portable workflow document runs in the open-source framework and on the platform. Compose it in code, or describe the agent in a sentence and let the builder draft it — memory layers, tools, and all.',
    signal: '@noetic-tools/core',
  },
  {
    number: '02',
    name: 'Run',
    lede: 'Durable sessions on real computers.',
    detail:
      'Every session gets a persistent Linux microVM — or your own desktop as the compute backend. Turns survive disconnects and evictions; the same live session follows you across web, terminal, iPhone, Mac, and ten chat platforms.',
    signal: 'microvm · desktop',
  },
  {
    number: '03',
    name: 'Observe',
    lede: 'Traces that know your workflow.',
    detail:
      'Every run captures real spans — each model call and tool call stamped with the workflow node that made it. The trace inspector lights up the exact path your agent took through its own DAG.',
    signal: 'noetic.node.id',
  },
  {
    number: '04',
    name: 'Prove',
    lede: 'Evals against real traffic.',
    detail:
      'Curate real sessions into training sets, annotate them, and run LLM-judge or code scorers against them like a test suite. Regressions surface before your users find them.',
    signal: 'scorers · training sets',
  },
  {
    number: '05',
    name: 'Improve',
    lede: 'GEPA-based self-improvement.',
    detail:
      'Synthesize reusable workflows from observed episodes, replay them behind a fidelity gate, then iterate prompt variants against held-out data. Your agents get better from their own production history.',
    signal: 'synthesize → reproduce → optimize',
  },
  {
    number: '06',
    name: 'Operate',
    lede: 'Permissions, metering — and billing, if you want it.',
    detail:
      'Orgs and roles, device keys, write-only secret vaults, hard usage caps with honest 402s. Going commercial? White-label the whole thing: your brand, your domains, your plans, your customers metered per seat.',
    signal: 'vaults · quotas · white-label',
  },
];

export function PlatformLoop(): ReactNode {
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
        <span className="code-section-eyebrow">{'01 / the loop'}</span>
        <h2 className="code-display-headline">
          Everything between <em>prompt and production.</em>
        </h2>
        <p
          style={{
            fontSize: '15px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.65,
          }}
        >
          Most stacks cover two or three of these and hand you integration homework for the rest.
          Noetic closes the whole loop — and every stage is optional, so you adopt the next one
          when you need it, never rewriting to climb.
        </p>
      </div>

      <div
        className="patterns-grid"
        style={{
          display: 'grid',
          gap: '4px',
        }}
      >
        {STAGES.map((stage, i) => (
          <motion.div
            key={stage.name}
            initial={{
              opacity: 0,
              y: 10,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            transition={{
              delay: i * 0.06,
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
              {stage.number}
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
                {stage.name}
              </div>
              <code
                style={{
                  fontSize: '11px',
                  color: 'var(--color-tui-cyan)',
                  letterSpacing: '0.04em',
                }}
              >
                {stage.signal}
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
              {stage.lede}
            </p>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-muted)',
                margin: 0,
                lineHeight: 1.65,
              }}
            >
              {stage.detail}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
