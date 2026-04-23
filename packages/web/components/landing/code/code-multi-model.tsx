'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { SectionBody } from '@/components/landing/section-body';
import { SectionHeader } from '@/components/landing/section-header';
import { TuiReadout } from '@/components/tui/tui-readout';

interface PhaseRow {
  phase: string;
  why: string;
  exampleModel: string;
  exampleProvider: string;
}

const PHASES: PhaseRow[] = [
  {
    phase: 'Planner',
    why: 'Decompose the task. Reasoning matters more than latency.',
    exampleModel: 'claude-sonnet-4',
    exampleProvider: 'anthropic',
  },
  {
    phase: 'Editor',
    why: 'Write the actual code. Code quality is everything.',
    exampleModel: 'claude-opus-4',
    exampleProvider: 'anthropic',
  },
  {
    phase: 'Reviewer',
    why: 'Catch regressions. Fast and cheap runs more often.',
    exampleModel: 'claude-haiku-4',
    exampleProvider: 'anthropic',
  },
  {
    phase: 'Embedder',
    why: 'Memory recall. Purpose-built beats general-purpose.',
    exampleModel: 'text-embedding-3-large',
    exampleProvider: 'openai',
  },
  {
    phase: 'Router',
    why: 'Quick decisions between steps. Milliseconds, not seconds.',
    exampleModel: 'gemini-2.5-flash',
    exampleProvider: 'google',
  },
];

const PHASE_COLUMNS = '140px 1fr 200px';

export function CodeMultiModel(): ReactNode {
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
            label="multi-model native"
            title="Not married to one model"
            margin="8px 0 12px"
          />
          <SectionBody
            lede="Every other coding agent is built around one model family. When that family ships a bad release, your agent gets worse."
            detail="Noetic Code routes each phase of the harness to the best model for the job. Planner, editor, reviewer, embedder, router — configure them separately. Swap any of them without touching the others. OpenRouter under the hood gives you 300+ models and one billing endpoint."
          />
        </div>

        <TuiReadout>
          <div
            style={{
              color: 'var(--color-tui-muted)',
            }}
          >
            {'// .noetic/config.ts'}
          </div>
          <div>{'models: {'}</div>
          <div>{'  planner:  "anthropic/claude-sonnet-4",'}</div>
          <div>{'  editor:   "anthropic/claude-opus-4",'}</div>
          <div>{'  reviewer: "anthropic/claude-haiku-4",'}</div>
          <div>{'  embed:    "openai/text-embedding-3-large",'}</div>
          <div>{'  router:   "google/gemini-2.5-flash",'}</div>
          <div>{'}'}</div>
        </TuiReadout>
      </div>

      <div
        style={{
          border: '1px solid var(--color-tui-border)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: PHASE_COLUMNS,
            padding: '12px 20px',
            borderBottom: '1px solid var(--color-tui-border)',
            background: 'var(--color-tui-bg)',
            fontSize: '11px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-tui-muted)',
            fontWeight: 700,
          }}
        >
          <span>phase</span>
          <span>why it matters</span>
          <span>example</span>
        </div>
        {PHASES.map((row, i) => (
          <motion.div
            key={row.phase}
            initial={{
              opacity: 0,
              x: -8,
            }}
            whileInView={{
              opacity: 1,
              x: 0,
            }}
            transition={{
              delay: i * 0.06,
              duration: 0.3,
            }}
            viewport={{
              once: true,
            }}
            style={{
              display: 'grid',
              gridTemplateColumns: PHASE_COLUMNS,
              padding: '18px 20px',
              borderBottom: i === PHASES.length - 1 ? 'none' : '1px solid var(--color-tui-border)',
              alignItems: 'baseline',
            }}
          >
            <span
              style={{
                fontSize: '13px',
                fontWeight: 700,
                color: 'var(--color-tui-green)',
                letterSpacing: '0.04em',
              }}
            >
              {row.phase}
            </span>
            <span
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-secondary)',
                lineHeight: 1.5,
              }}
            >
              {row.why}
            </span>
            <span
              style={{
                fontSize: '12px',
                color: 'var(--color-tui-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span
                style={{
                  color: 'var(--color-tui-cyan)',
                }}
              >
                {row.exampleProvider}
              </span>
              {'/'}
              {row.exampleModel}
            </span>
          </motion.div>
        ))}
      </div>

      <p
        style={{
          marginTop: '24px',
          padding: '14px 16px',
          border: '1px solid var(--color-tui-border)',
          fontSize: '13px',
          color: 'var(--color-tui-secondary)',
          background: 'var(--color-tui-surface)',
        }}
      >
        Anthropic, OpenAI, Google, Mistral, local models via Ollama. Pick per phase, swap on a whim.
        Your agent harness does not care.
      </p>
    </section>
  );
}
