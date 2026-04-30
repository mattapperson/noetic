'use client';

import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

type LayerTone = 'working' | 'retrieval' | 'persistence' | 'control';

interface LayerCard {
  index: string;
  name: string;
  description: string;
  tone: LayerTone;
}

interface MeterRow {
  label: string;
  used: number;
  budget: number;
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

const METERS: MeterRow[] = [
  {
    label: 'working',
    used: 1842,
    budget: 2400,
    tone: 'working',
  },
  {
    label: 'observations',
    used: 612,
    budget: 2000,
    tone: 'working',
  },
  {
    label: 'semantic',
    used: 4021,
    budget: 8000,
    tone: 'retrieval',
  },
  {
    label: 'episodic',
    used: 401,
    budget: 2000,
    tone: 'retrieval',
  },
  {
    label: 'plan',
    used: 2880,
    budget: 3000,
    tone: 'persistence',
  },
];

const TOTAL_USED = METERS.reduce((sum, m) => sum + m.used, 0);
const TOTAL_BUDGET = METERS.reduce((sum, m) => sum + m.budget, 0);
const TOTAL_PCT = Math.round((TOTAL_USED / TOTAL_BUDGET) * 100);

function formatTokens(n: number): string {
  return n.toLocaleString();
}

type CssWithVars = CSSProperties & Record<`--${string}`, string | number>;

function meterStyle(used: number, budget: number): CssWithVars {
  const fill = Math.min(used / budget, 1);
  return {
    background: 'currentColor',
    transformOrigin: 'left center',
    transform: 'scaleX(0)',
    animation: 'fill-bar 1.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards',
    '--bar-fill': String(fill),
  };
}

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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: '32px',
          alignItems: 'start',
        }}
        className="ctx-grid"
      >
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
          style={{
            position: 'sticky',
            top: '96px',
            background: 'var(--color-tui-bg-deep)',
            border: '1px solid var(--color-tui-border-bright)',
            borderRadius: '6px',
            overflow: 'hidden',
            boxShadow: '0 24px 60px -32px rgba(57, 255, 20, 0.18)',
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
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--color-tui-green)',
                boxShadow: '0 0 8px var(--color-tui-green)',
              }}
            />
            <span
              style={{
                fontSize: '11px',
                color: 'var(--color-tui-secondary)',
                letterSpacing: '0.06em',
              }}
            >
              $ noetic --memory-budget
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: '10px',
                color: 'var(--color-tui-muted)',
              }}
            >
              live
            </span>
          </div>

          <div
            style={{
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              fontSize: '12px',
            }}
          >
            {METERS.map((m) => {
              const pct = Math.round((m.used / m.budget) * 100);
              return (
                <div key={m.label}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '6px',
                      color: 'var(--color-tui-secondary)',
                    }}
                  >
                    <span
                      style={{
                        color: TONE_COLOR[m.tone],
                      }}
                    >
                      {m.label}
                    </span>
                    <span
                      style={{
                        color: 'var(--color-tui-muted)',
                      }}
                    >
                      {`${formatTokens(m.used)} / ${formatTokens(m.budget)} · ${pct}%`}
                    </span>
                  </div>
                  <div className="code-meter-track">
                    <div
                      className="code-meter-fill"
                      style={{
                        ...meterStyle(m.used, m.budget),
                        color: TONE_COLOR[m.tone],
                      }}
                    />
                  </div>
                </div>
              );
            })}

            <div
              style={{
                marginTop: '8px',
                paddingTop: '14px',
                borderTop: '1px dashed var(--color-tui-border)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                  color: 'var(--color-tui-fg)',
                  fontWeight: 700,
                }}
              >
                <span>total</span>
                <span
                  style={{
                    color: 'var(--color-tui-green)',
                  }}
                >
                  {`${formatTokens(TOTAL_USED)} / ${formatTokens(TOTAL_BUDGET)} · ${TOTAL_PCT}%`}
                </span>
              </div>
              <div
                className="code-meter-track"
                style={{
                  height: '10px',
                }}
              >
                <div
                  className="code-meter-fill"
                  style={{
                    ...meterStyle(TOTAL_USED, TOTAL_BUDGET),
                    color: 'var(--color-tui-green)',
                    boxShadow: '0 0 12px var(--color-tui-green)',
                  }}
                />
              </div>
            </div>

            <div
              style={{
                marginTop: '4px',
                fontSize: '11px',
                color: 'var(--color-tui-muted)',
                lineHeight: 1.5,
              }}
            >
              {'// Each layer is independently budgeted. Hit a ceiling? Only that layer'}
              <br />
              {'// gets compacted — the rest stays sharp.'}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
