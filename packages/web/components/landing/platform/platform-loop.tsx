'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { LiveDot } from '@/components/landing/code/live-dot';

interface LoopStage {
  number: string;
  name: string;
  lede: string;
  detail: string;
  signal: string;
  color: string;
}

const STAGES: LoopStage[] = [
  {
    number: '01',
    name: 'build',
    lede: 'TypeScript primitives or plain language.',
    detail:
      'The same portable workflow document runs in the open-source framework and on the platform. Compose it in code, or describe the agent in a sentence and let the builder draft it — memory layers, tools, and all.',
    signal: '@noetic-tools/core',
    color: 'var(--color-tui-green)',
  },
  {
    number: '02',
    name: 'run',
    lede: 'Durable sessions on real computers.',
    detail:
      'Every session gets a persistent Linux microVM — or your own desktop as the compute backend. Turns survive disconnects and evictions; the same live session follows you across web, terminal, iPhone, Mac, and ten chat platforms.',
    signal: 'microvm · desktop',
    color: 'var(--color-tui-green)',
  },
  {
    number: '03',
    name: 'observe',
    lede: 'Traces that know your workflow.',
    detail:
      'Every run captures real spans — each model call and tool call stamped with the workflow node that made it. The trace inspector lights up the exact path your agent took through its own DAG.',
    signal: 'noetic.node.id',
    color: 'var(--color-tui-cyan)',
  },
  {
    number: '04',
    name: 'prove',
    lede: 'Evals against real traffic.',
    detail:
      'Curate real sessions into training sets, annotate them, and run LLM-judge or code scorers against them like a test suite. Regressions surface before your users find them.',
    signal: 'scorers · training sets',
    color: 'var(--color-tui-cyan)',
  },
  {
    number: '05',
    name: 'improve',
    lede: 'GEPA-based self-improvement.',
    detail:
      'Synthesize reusable workflows from observed episodes, replay them behind a fidelity gate, then iterate prompt variants against held-out data. Your agents get better from their own production history.',
    signal: 'synthesize → reproduce → optimize',
    color: 'var(--color-tui-amber)',
  },
  {
    number: '06',
    name: 'operate',
    lede: 'Permissions, metering — and billing, if you want it.',
    detail:
      'Orgs and roles, device keys, write-only secret vaults, hard usage caps with honest 402s. Going commercial? White-label the whole thing: your brand, your domains, your plans, your customers metered per seat.',
    signal: 'vaults · quotas · white-label',
    color: 'var(--color-tui-green)',
  },
];

const BAR_STEP = 12.5;
const BAR_WIDTH = 31;

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
          Most stacks cover two or three of these stages and hand you integration homework for the
          rest. Noetic closes the whole loop — and every stage is optional, so you adopt the next
          one when you need it, never rewriting to climb. Here is the lifecycle, the way the
          platform itself would trace it:
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
          <span>$ noetic trace agent-lifecycle</span>
          <span
            style={{
              marginLeft: 'auto',
              color: 'var(--color-tui-muted)',
              fontSize: '10px',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            workflow.run — 6 spans
          </span>
        </div>

        {STAGES.map((stage, i) => (
          <motion.div
            key={stage.name}
            initial={{
              opacity: 0,
            }}
            whileInView={{
              opacity: 1,
            }}
            transition={{
              delay: i * 0.08,
              duration: 0.35,
            }}
            viewport={{
              once: true,
              margin: '-60px',
            }}
            style={{
              padding: '18px 20px 20px',
              borderBottom: '1px solid var(--color-tui-border)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                flexWrap: 'wrap',
                marginBottom: '10px',
              }}
            >
              <span
                style={{
                  width: '132px',
                  flexShrink: 0,
                  fontSize: '13px',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--color-tui-fg)',
                }}
              >
                <span
                  style={{
                    color: stage.color,
                    marginRight: '8px',
                  }}
                >
                  {stage.number}
                </span>
                {stage.name}
              </span>

              <span
                aria-hidden="true"
                style={{
                  flex: 1,
                  minWidth: '160px',
                  height: '8px',
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '3.5px',
                    height: '1px',
                    background: 'var(--color-tui-border)',
                  }}
                />
                <motion.span
                  initial={{
                    scaleX: 0,
                  }}
                  whileInView={{
                    scaleX: 1,
                  }}
                  transition={{
                    delay: 0.15 + i * 0.08,
                    duration: 0.4,
                  }}
                  viewport={{
                    once: true,
                    margin: '-60px',
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    height: '8px',
                    borderRadius: '2px',
                    left: `${i * BAR_STEP}%`,
                    width: `${BAR_WIDTH}%`,
                    background: stage.color,
                    opacity: 0.85,
                    transformOrigin: 'left',
                  }}
                />
              </span>

              <code
                style={{
                  fontSize: '11px',
                  color: 'var(--color-tui-cyan)',
                  letterSpacing: '0.04em',
                  flexShrink: 0,
                }}
              >
                {stage.signal}
              </code>
            </div>

            <p
              style={{
                margin: 0,
                maxWidth: '760px',
                fontSize: '13px',
                lineHeight: 1.65,
              }}
            >
              <span
                style={{
                  color: 'var(--color-tui-secondary)',
                  fontWeight: 600,
                }}
              >
                {stage.lede}
              </span>{' '}
              <span
                style={{
                  color: 'var(--color-tui-muted)',
                }}
              >
                {stage.detail}
              </span>
            </p>
          </motion.div>
        ))}

        <div
          style={{
            padding: '14px 20px',
            fontSize: '12px',
            letterSpacing: '0.06em',
            color: 'var(--color-tui-green)',
            borderTop: '1px dashed var(--color-tui-border-bright)',
            background: 'var(--color-tui-surface)',
          }}
        >
          {'└── traces from this run feed the next improve pass — the loop closes ↩'}
        </div>
      </motion.div>
    </section>
  );
}
