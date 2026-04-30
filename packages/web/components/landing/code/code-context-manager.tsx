'use client';

import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { NoeticContextDisplay } from '@/components/landing/code/noetic-context-display';

type LayerTone = 'working' | 'retrieval' | 'persistence' | 'control';

interface LayerCard {
  index: string;
  name: string;
  description: string;
  tone: LayerTone;
}

const TONE_COLOR: Record<LayerTone, string> = {
  working: 'var(--color-tui-cyan)',
  retrieval: 'var(--color-tui-green)',
  persistence: 'var(--color-tui-amber)',
  control: 'var(--color-tui-magenta)',
};

const TONE_LABEL: Record<LayerTone, string> = {
  working: 'Working',
  retrieval: 'Retrieval',
  persistence: 'Persistence',
  control: 'Control',
};

const LAYERS: LayerCard[] = [
  {
    index: '01',
    name: 'Working Memory',
    description: 'Scratchpad for the current turn. Forgotten on the next.',
    tone: 'working',
  },
  {
    index: '02',
    name: 'Observational Memory',
    description: 'Auto-extracted facts from what just happened.',
    tone: 'working',
  },
  {
    index: '03',
    name: 'Static Content',
    description: 'Project rules, style guides, invariants that do not change.',
    tone: 'working',
  },
  {
    index: '04',
    name: 'Tool Memory',
    description: 'Per-tool state — bash history, LSP diagnostics, open files.',
    tone: 'working',
  },
  {
    index: '05',
    name: 'File Reference',
    description: 'Tracks files the agent has opened, edited, or staged.',
    tone: 'working',
  },
  {
    index: '06',
    name: 'Semantic Recall',
    description: 'Vector-indexed long-term memory. Pulls only what is relevant.',
    tone: 'retrieval',
  },
  {
    index: '07',
    name: 'Episodic Memory',
    description: 'Summaries of past conversations, indexed by task and outcome.',
    tone: 'retrieval',
  },
  {
    index: '08',
    name: 'Plan Memory',
    description: 'PRDs, task breakdowns, and checkpointed progress across runs.',
    tone: 'retrieval',
  },
  {
    index: '09',
    name: 'Durable Task State',
    description: 'Persistent artifacts that survive restarts and process crashes.',
    tone: 'persistence',
  },
  {
    index: '10',
    name: 'Steering',
    description: 'Governance layer. Redirects or blocks unsafe tool calls.',
    tone: 'control',
  },
];

type CssWithVars = CSSProperties & Record<`--${string}`, string | number>;

function stackAccentStyle(color: string): CssWithVars {
  return {
    '--stack-accent': color,
  };
}

export function CodeContextManager(): ReactNode {
  return (
    <section className="code-section">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: '12px',
          marginBottom: '48px',
        }}
      >
        <span className="code-section-eyebrow">{'01 / context manager'}</span>
        <h2 className="code-display-headline">
          Ten layers, <em>one mind.</em>
        </h2>
        <p
          style={{
            fontSize: '17px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.55,
            maxWidth: '780px',
          }}
        >
          Most coding agents have one trick for memory: cram it all in, pray the model finds it.
        </p>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--color-tui-muted)',
            margin: 0,
            lineHeight: 1.7,
            maxWidth: '780px',
          }}
        >
          Noetic Code ships ten specialized layers. Each has its own lifecycle, scope, and budget.
          The agent pulls what it needs, when it needs it. Your context window stays predictable no
          matter how long the session runs.
        </p>
      </div>

      <div className="ctx-grid">
        <div className="code-stack-grid">
          {LAYERS.map((layer, i) => (
            <motion.div
              key={layer.index}
              initial={{
                opacity: 0,
                x: -8,
              }}
              whileInView={{
                opacity: 1,
                x: 0,
              }}
              transition={{
                delay: i * 0.04,
                duration: 0.3,
              }}
              viewport={{
                once: true,
              }}
              className="code-stack-card"
              style={stackAccentStyle(TONE_COLOR[layer.tone])}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                }}
              >
                <span
                  style={{
                    fontSize: '10px',
                    color: 'var(--color-tui-muted)',
                    letterSpacing: '0.16em',
                  }}
                >
                  {`L${layer.index}`}
                </span>
                <span
                  style={{
                    fontSize: '9px',
                    color: TONE_COLOR[layer.tone],
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    opacity: 0.85,
                  }}
                >
                  {TONE_LABEL[layer.tone]}
                </span>
              </div>
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: 'var(--color-tui-fg)',
                  letterSpacing: '-0.01em',
                  marginBottom: '6px',
                }}
              >
                {layer.name}
              </div>
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--color-tui-muted)',
                  lineHeight: 1.55,
                }}
              >
                {layer.description}
              </div>
            </motion.div>
          ))}
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
          className="ctx-sticky"
        >
          <NoeticContextDisplay />
        </motion.div>
      </div>
    </section>
  );
}
