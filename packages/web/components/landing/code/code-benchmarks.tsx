'use client';

import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

interface BenchmarkCard {
  rank: string;
  name: string;
  subtitle: string;
  detail: string;
  score: number;
  baseline: number;
  baselineLabel: string;
}

const BENCHMARKS: BenchmarkCard[] = [
  {
    rank: '#1',
    name: 'Terminal-Bench',
    subtitle: 'end-to-end software engineering in a real shell',
    detail: 'Measures the full loop: read, edit, run, recover. Not just code completion.',
    score: 78,
    baseline: 54,
    baselineLabel: 'next-best',
  },
  {
    rank: '#1',
    name: 'Long-Mem Eval',
    subtitle: 'coherence across hours of context',
    detail: 'Tests whether an agent still remembers turn 3 when it reaches turn 300.',
    score: 91,
    baseline: 47,
    baselineLabel: 'next-best',
  },
];

type CssWithVars = CSSProperties & Record<`--${string}`, string | number>;

function barStyle(pct: number, color: string): CssWithVars {
  return {
    background: color,
    transformOrigin: 'left center',
    transform: 'scaleX(0)',
    animation: 'fill-bar 1.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards',
    '--bar-fill': String(pct / 100),
  };
}

export function CodeBenchmarks(): ReactNode {
  return (
    <section className="code-section">
      <div
        style={{
          display: 'grid',
          gap: '16px',
          marginBottom: '40px',
          maxWidth: '760px',
        }}
      >
        <span className="code-section-eyebrow">{'02 / how it stacks up'}</span>
        <h2 className="code-display-headline">
          Benchmarked, <em>not vibes.</em>
        </h2>
        <p
          style={{
            fontSize: '15px',
            color: 'var(--color-tui-secondary)',
            margin: 0,
            lineHeight: 1.65,
          }}
        >
          Two benchmarks where Noetic Code lands first. Both happen to test the things every other
          coding agent quietly fails at: long-running tasks and shell reliability.
        </p>
      </div>

      <div className="code-bench-grid">
        {BENCHMARKS.map((bench, i) => (
          <motion.div
            key={bench.name}
            initial={{
              opacity: 0,
              y: 12,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            transition={{
              delay: i * 0.1,
              duration: 0.4,
            }}
            viewport={{
              once: true,
            }}
            style={{
              background: 'var(--color-tui-surface)',
              padding: '36px 36px 32px',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '12px',
                right: '14px',
                fontSize: '10px',
                letterSpacing: '0.2em',
                color: 'var(--color-tui-muted)',
                textTransform: 'uppercase',
              }}
            >
              {`bench.${(i + 1).toString().padStart(2, '0')}`}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: '20px',
              }}
            >
              <span
                className="tui-glow"
                style={{
                  fontSize: 'clamp(72px, 9vw, 112px)',
                  fontWeight: 800,
                  color: 'var(--color-tui-green)',
                  lineHeight: 0.85,
                  letterSpacing: '-0.04em',
                }}
              >
                {bench.rank}
              </span>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  paddingBottom: '8px',
                }}
              >
                <span
                  style={{
                    fontSize: '20px',
                    fontWeight: 700,
                    color: 'var(--color-tui-fg)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {bench.name}
                </span>
                <span
                  style={{
                    fontSize: '12px',
                    color: 'var(--color-tui-muted)',
                    fontFamily: 'var(--font-serif)',
                    fontStyle: 'italic',
                  }}
                >
                  {bench.subtitle}
                </span>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  fontSize: '11px',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}
              >
                <span
                  style={{
                    color: 'var(--color-tui-green)',
                    width: '64px',
                  }}
                >
                  noetic
                </span>
                <div
                  className="code-meter-track"
                  style={{
                    flex: 1,
                    height: '14px',
                  }}
                >
                  <div
                    className="code-meter-fill"
                    style={barStyle(bench.score, 'var(--color-tui-green)')}
                  />
                </div>
                <span
                  style={{
                    color: 'var(--color-tui-green)',
                    minWidth: '36px',
                    textAlign: 'right',
                  }}
                >
                  {bench.score}
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  fontSize: '11px',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}
              >
                <span
                  style={{
                    color: 'var(--color-tui-muted)',
                    width: '64px',
                  }}
                >
                  {bench.baselineLabel}
                </span>
                <div
                  className="code-meter-track"
                  style={{
                    flex: 1,
                    height: '14px',
                  }}
                >
                  <div
                    className="code-meter-fill"
                    style={barStyle(bench.baseline, 'var(--color-tui-faint)')}
                  />
                </div>
                <span
                  style={{
                    color: 'var(--color-tui-muted)',
                    minWidth: '36px',
                    textAlign: 'right',
                  }}
                >
                  {bench.baseline}
                </span>
              </div>
            </div>

            <p
              style={{
                fontSize: '13px',
                color: 'var(--color-tui-secondary)',
                margin: 0,
                lineHeight: 1.65,
              }}
            >
              {bench.detail}
            </p>
          </motion.div>
        ))}
      </div>

      <div
        style={{
          marginTop: '24px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          border: '1px dashed var(--color-tui-border)',
          fontSize: '12px',
          color: 'var(--color-tui-muted)',
          letterSpacing: '0.04em',
        }}
      >
        <span>
          Reproduce locally with{' '}
          <code
            style={{
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-tui-fg)',
              padding: '1px 6px',
              background: 'var(--color-tui-surface)',
              border: '1px solid var(--color-tui-border)',
              borderRadius: '3px',
            }}
          >
            noetic test
          </code>
          . Methodology and full numbers publishing soon.
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '10px',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--color-tui-amber)',
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: 'var(--color-tui-amber)',
              boxShadow: '0 0 6px var(--color-tui-amber)',
            }}
          />
          verification pending
        </span>
      </div>
    </section>
  );
}
