'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

type Provider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'local';

interface PhaseRow {
  phase: string;
  why: string;
  exampleModel: string;
  exampleProvider: Provider;
}

const PROVIDER_COLOR: Record<Provider, string> = {
  anthropic: 'var(--color-tui-amber)',
  openai: 'var(--color-tui-green)',
  google: 'var(--color-tui-cyan)',
  mistral: 'var(--color-tui-magenta)',
  local: 'var(--color-tui-secondary)',
};

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

const SUPPORTED_PROVIDERS: Array<{
  name: Provider;
  label: string;
}> = [
  {
    name: 'anthropic',
    label: 'anthropic',
  },
  {
    name: 'openai',
    label: 'openai',
  },
  {
    name: 'google',
    label: 'google',
  },
  {
    name: 'mistral',
    label: 'mistral',
  },
  {
    name: 'local',
    label: 'local · ollama',
  },
];

export function CodeMultiModel(): ReactNode {
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
        <span className="code-section-eyebrow">{'04 / multi-model native'}</span>
        <h2 className="code-display-headline">
          Not married to <em>one model.</em>
        </h2>
        <p
          style={{
            fontSize: '15px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.65,
          }}
        >
          Every other coding agent is built around one model family. When that family ships a bad
          release, your agent gets worse with it.
        </p>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--color-tui-muted)',
            margin: 0,
            lineHeight: 1.7,
          }}
        >
          Noetic Code routes each phase of the harness to the best model for the job. Swap any of
          them without touching the others. OpenRouter under the hood gives you 300+ models and one
          billing endpoint.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: '32px',
          alignItems: 'start',
        }}
        className="ctx-grid"
      >
        <div
          style={{
            border: '1px solid var(--color-tui-border-bright)',
            borderRadius: '6px',
            overflow: 'hidden',
            background: 'var(--color-tui-bg-deep)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 18px',
              borderBottom: '1px solid var(--color-tui-border)',
              background: 'var(--color-tui-surface-2)',
              fontSize: '11px',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--color-tui-muted)',
            }}
          >
            <span>phase routing</span>
            <span
              style={{
                marginLeft: 'auto',
              }}
            >
              example
            </span>
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
              className="code-routing-row"
            >
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: 'var(--color-tui-fg)',
                  letterSpacing: '0.02em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <span
                  style={{
                    fontSize: '10px',
                    color: 'var(--color-tui-muted)',
                    letterSpacing: '0.16em',
                  }}
                >
                  {`P${(i + 1).toString().padStart(2, '0')}`}
                </span>
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-mono)',
                  justifySelf: 'end',
                }}
              >
                <span
                  style={{
                    color: PROVIDER_COLOR[row.exampleProvider],
                    fontWeight: 700,
                  }}
                >
                  {row.exampleProvider}
                </span>
                <span
                  style={{
                    color: 'var(--color-tui-muted)',
                  }}
                >
                  /
                </span>
                <span
                  style={{
                    color: 'var(--color-tui-fg)',
                  }}
                >
                  {row.exampleModel}
                </span>
              </span>
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
          style={{
            position: 'sticky',
            top: '96px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          <div
            style={{
              background: 'var(--color-tui-bg-deep)',
              border: '1px solid var(--color-tui-border-bright)',
              borderRadius: '6px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--color-tui-border)',
                background: 'var(--color-tui-surface-2)',
                fontSize: '11px',
                color: 'var(--color-tui-muted)',
                letterSpacing: '0.06em',
              }}
            >
              {'// .noetic/config.ts'}
            </div>
            <pre
              style={{
                margin: 0,
                padding: '20px',
                fontSize: '12.5px',
                lineHeight: 1.7,
                color: 'var(--color-tui-secondary)',
                fontFamily: 'var(--font-mono), monospace',
              }}
            >
              <span
                style={{
                  color: 'var(--color-tui-cyan)',
                }}
              >
                {'export const'}
              </span>
              <span>{' config = '}</span>
              <span
                style={{
                  color: 'var(--color-tui-fg)',
                }}
              >
                {'{\n'}
              </span>
              <span>{'  '}</span>
              <span
                style={{
                  color: 'var(--color-tui-amber)',
                }}
              >
                models
              </span>
              <span>{': {\n'}</span>
              <span>{'    planner:  '}</span>
              <span
                style={{
                  color: 'var(--color-tui-green)',
                }}
              >
                {'"anthropic/claude-sonnet-4"'}
              </span>
              <span>{',\n'}</span>
              <span>{'    editor:   '}</span>
              <span
                style={{
                  color: 'var(--color-tui-green)',
                }}
              >
                {'"anthropic/claude-opus-4"'}
              </span>
              <span>{',\n'}</span>
              <span>{'    reviewer: '}</span>
              <span
                style={{
                  color: 'var(--color-tui-green)',
                }}
              >
                {'"anthropic/claude-haiku-4"'}
              </span>
              <span>{',\n'}</span>
              <span>{'    embed:    '}</span>
              <span
                style={{
                  color: 'var(--color-tui-green)',
                }}
              >
                {'"openai/text-embedding-3-large"'}
              </span>
              <span>{',\n'}</span>
              <span>{'    router:   '}</span>
              <span
                style={{
                  color: 'var(--color-tui-green)',
                }}
              >
                {'"google/gemini-2.5-flash"'}
              </span>
              <span>{',\n'}</span>
              <span>{'  },\n'}</span>
              <span
                style={{
                  color: 'var(--color-tui-fg)',
                }}
              >
                {'}'}
              </span>
            </pre>
          </div>

          <div
            style={{
              padding: '18px 20px',
              border: '1px solid var(--color-tui-border)',
              background: 'var(--color-tui-surface)',
              borderRadius: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <span
              style={{
                fontSize: '10px',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--color-tui-muted)',
              }}
            >
              available providers
            </span>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
              }}
            >
              {SUPPORTED_PROVIDERS.map((p) => (
                <span
                  key={p.name}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 10px',
                    border: '1px solid var(--color-tui-border)',
                    background: 'var(--color-tui-bg-deep)',
                    borderRadius: '999px',
                    fontSize: '11px',
                    color: 'var(--color-tui-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <span
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: PROVIDER_COLOR[p.name],
                      boxShadow: `0 0 6px ${PROVIDER_COLOR[p.name]}`,
                    }}
                  />
                  {p.label}
                </span>
              ))}
            </div>
            <p
              style={{
                margin: 0,
                fontSize: '12px',
                color: 'var(--color-tui-muted)',
                lineHeight: 1.55,
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
              }}
            >
              300+ models, one billing endpoint. Pick per phase. Swap on a whim. Your agent harness
              does not care.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
