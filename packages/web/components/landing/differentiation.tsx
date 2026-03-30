import type { ReactNode } from 'react';

interface CompetitorRow {
  name: string;
  pain: string;
  isNoetic?: boolean;
}

const ROWS: CompetitorRow[] = [
  {
    name: 'LangChain',
    pain: 'Magic on the way in. Black box on the way out.',
  },
  {
    name: 'LangGraph',
    pain: "Powerful. Also: now you're a graph theorist.",
  },
  {
    name: 'CrewAI',
    pain: "Works great until it doesn't.",
  },
  {
    name: 'AI SDK',
    pain: 'Too magical a primitive to build anything with confidence.',
  },
  {
    name: 'Noetic',
    pain: "Seven primitives. Read it, extend it, ship it — it's just TypeScript.",
    isNoetic: true,
  },
];

export function Differentiation(): ReactNode {
  return (
    <section
      style={{
        padding: '80px 24px',
        maxWidth: '1280px',
        margin: '0 auto',
      }}
    >
      <span
        style={{
          fontSize: '13px',
          color: 'var(--color-tui-muted)',
          letterSpacing: '0.1em',
        }}
      >
        {'// the landscape'}
      </span>
      <h2
        style={{
          fontSize: '38px',
          fontWeight: 700,
          margin: '8px 0 40px',
          textTransform: 'uppercase',
          letterSpacing: '-0.01em',
        }}
      >
        What makes Noetic different?
      </h2>

      <div
        style={{
          border: '1px solid var(--color-tui-border)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {ROWS.map((row) => (
          <div
            key={row.name}
            className="diff-row"
            style={{
              display: 'grid',
              borderBottom: '1px solid var(--color-tui-border)',
              borderLeft: row.isNoetic
                ? '2px solid var(--color-tui-green)'
                : '2px solid transparent',
              background: row.isNoetic ? 'var(--color-tui-surface)' : 'transparent',
            }}
          >
            <div
              style={{
                padding: '20px',
                fontSize: '13px',
                fontWeight: row.isNoetic ? 700 : 400,
                color: row.isNoetic ? 'var(--color-tui-green)' : 'var(--color-tui-muted)',
                borderRight: '1px solid var(--color-tui-border)',
              }}
            >
              {row.name}
            </div>
            <div
              style={{
                padding: '20px',
                fontSize: '13px',
                fontWeight: row.isNoetic ? 700 : 400,
                color: row.isNoetic ? 'var(--color-tui-fg)' : 'var(--color-tui-secondary)',
              }}
            >
              {row.pain}
            </div>
          </div>
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
        OpenAI, Anthropic, local models, or a custom adapter. Bring your own provider.
      </p>
    </section>
  );
}
