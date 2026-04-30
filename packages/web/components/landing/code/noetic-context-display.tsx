'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import type { ContextRow } from '@/lib/noetic-tui-snapshots.generated';
import { CONTEXT_SNAPSHOT } from '@/lib/noetic-tui-snapshots.generated';

const VAPOR = {
  bg: '#0D0B10',
  fg: '#F0E6FF',
  muted: '#A69CBD',
  placeholder: '#7C7290',
  primary: '#FF71CE',
  accent: '#01CDFE',
  blue: '#5BC4FF',
  secondary: '#B967FF',
  success: '#05FFA1',
  warning: '#FFC164',
  border: '#3a2d4d',
  divider: '#2a1f3a',
} as const;

type RowColor = 'magenta' | 'blue' | 'cyan' | 'green';

const ROW_COLOR: Record<RowColor, string> = {
  magenta: VAPOR.primary,
  blue: VAPOR.blue,
  cyan: VAPOR.accent,
  green: VAPOR.success,
};

interface LayerInfo {
  id: string;
  state: 'active' | 'inactive';
  tokens?: string;
  itemCount?: number;
  preview?: string;
}

const MODEL_ID = CONTEXT_SNAPSHOT.modelId;
const TOTAL_USED = CONTEXT_SNAPSHOT.totalUsed;
const TOTAL_LIMIT = CONTEXT_SNAPSHOT.totalLimit;
const TOTAL_PCT = CONTEXT_SNAPSHOT.totalPct;
const ROWS: ReadonlyArray<ContextRow> = CONTEXT_SNAPSHOT.overviewRows;

// Per-layer illustrative content. The set of layer ids displayed comes from
// the live CLI capture in CONTEXT_SNAPSHOT.layerIds — anything missing here
// falls back to "inactive on last run", matching the real CLI's empty state.
const LAYER_DETAILS: Record<string, Omit<LayerInfo, 'id'>> = {
  'agent-md': {
    state: 'active',
    tokens: '5.3k',
    itemCount: 1,
    preview:
      '[developer] # Project & User Instructions (AGENT.md) Contents of ~/my-project/AGENT.md…',
  },
  'skills-memory': {
    state: 'active',
    tokens: '532',
    itemCount: 3,
    preview: '[message] noetic-eval · noetic-agent-builder · branch-safe',
  },
  reminder: {
    state: 'active',
    tokens: '42',
    itemCount: 1,
    preview: '[reminder] Daily standup pings due 9am UTC.',
  },
  'durable-task-state': {
    state: 'active',
    tokens: '20',
    itemCount: 1,
    preview: '[task] dark-mode-toggle · status: routing',
  },
};

const LAYERS: LayerInfo[] = CONTEXT_SNAPSHOT.layerIds.map((id) => {
  const details = LAYER_DETAILS[id] ?? {
    state: 'inactive' as const,
  };
  return {
    id,
    ...details,
  };
});

const TAB_IDS: ReadonlyArray<string> = [
  '__overview',
  ...CONTEXT_SNAPSHOT.layerIds,
];
type TabId = string;

const BAR_WIDTH = 24;

function buildBar(pct: number): {
  filled: string;
  empty: string;
} {
  const cells = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)));
  return {
    filled: '█'.repeat(cells),
    empty: '░'.repeat(BAR_WIDTH - cells),
  };
}

const baseRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '14ch 5ch auto',
  alignItems: 'baseline',
  gap: '1.4ch',
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  fontSize: 'inherit',
  whiteSpace: 'nowrap',
};

function HeaderTab({
  label,
  isActive,
  onSelect,
}: {
  label: string;
  isActive: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        background: isActive ? VAPOR.accent : 'transparent',
        color: isActive ? VAPOR.bg : VAPOR.muted,
        fontWeight: isActive ? 700 : 400,
        border: 'none',
        padding: '2px 8px',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        letterSpacing: '0.02em',
        cursor: 'pointer',
        borderRadius: '2px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function OverviewTab(): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        color: VAPOR.fg,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '1.4ch',
        }}
      >
        <span
          style={{
            color: VAPOR.muted,
            minWidth: '14ch',
          }}
        >
          Model
        </span>
        <span
          style={{
            color: VAPOR.accent,
          }}
        >
          {MODEL_ID}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: '1.4ch',
        }}
      >
        <span
          style={{
            color: VAPOR.muted,
            minWidth: '14ch',
          }}
        >
          Context window
        </span>
        <span>
          <span
            style={{
              color: VAPOR.warning,
            }}
          >
            {TOTAL_USED}
          </span>
          <span
            style={{
              color: VAPOR.muted,
            }}
          >{` / ${TOTAL_LIMIT} tokens (${TOTAL_PCT.toFixed(1)}%)`}</span>
        </span>
      </div>
      <div
        style={{
          height: '0.6em',
        }}
      />
      {ROWS.map((row) => (
        <div key={row.label} style={baseRowStyle}>
          <span
            style={{
              color: ROW_COLOR[row.color],
            }}
          >
            {row.label}
          </span>
          <span
            style={{
              color: VAPOR.fg,
              fontVariantNumeric: 'tabular-nums',
              minWidth: '6ch',
              textAlign: 'right',
            }}
          >
            {row.tokens}
          </span>
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.04em',
            }}
          >
            <span
              style={{
                color: VAPOR.muted,
                marginRight: '0.8ch',
              }}
            >
              {row.pct.toFixed(1)}%
            </span>
            <span
              style={{
                color: ROW_COLOR[row.color],
              }}
            >
              {buildBar(row.pct).filled}
            </span>
            <span
              style={{
                color: ROW_COLOR[row.color],
                opacity: 0.22,
              }}
            >
              {buildBar(row.pct).empty}
            </span>
          </span>
        </div>
      ))}
      <div
        style={{
          height: '0.6em',
        }}
      />
      <div
        style={{
          color: VAPOR.muted,
          fontSize: '0.92em',
        }}
      >
        Tab/Shift+Tab or ←/→ to switch tabs. ↓ to scroll layer content, ↑ to return to tabs.
      </div>
    </div>
  );
}

function LayerTabContent({ layer }: { layer: LayerInfo }): ReactNode {
  if (layer.state === 'inactive') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          color: VAPOR.fg,
        }}
      >
        <span>
          <span
            style={{
              color: VAPOR.accent,
            }}
          >
            {layer.id}
          </span>
          <span
            style={{
              color: VAPOR.muted,
            }}
          >
            {' '}
            · inactive on last run
          </span>
        </span>
        <div
          style={{
            height: '0.4em',
          }}
        />
        <span
          style={{
            color: VAPOR.muted,
          }}
        >
          This layer is registered but did not contribute items on the last LLM call.
        </span>
        <span
          style={{
            color: VAPOR.muted,
          }}
        >
          Some layers (e.g. planMemory) only activate once a corresponding flow has started.
        </span>
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        color: VAPOR.fg,
      }}
    >
      <span>
        <span
          style={{
            color: VAPOR.accent,
          }}
        >
          {layer.id}
        </span>
        <span
          style={{
            color: VAPOR.muted,
          }}
        >
          {` · ${layer.itemCount} item${(layer.itemCount ?? 0) === 1 ? '' : 's'} · ${layer.tokens} tokens`}
        </span>
      </span>
      <div
        style={{
          height: '0.4em',
        }}
      />
      <span
        style={{
          color: VAPOR.muted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
        }}
      >
        {layer.preview}
      </span>
    </div>
  );
}

function tabLabel(id: TabId): string {
  if (id === '__overview') {
    return 'Overview';
  }
  return id;
}

export function NoeticContextDisplay(): ReactNode {
  const [active, setActive] = useState<TabId>('__overview');

  return (
    <div
      style={{
        background: VAPOR.bg,
        border: `1px solid ${VAPOR.border}`,
        borderRadius: '6px',
        overflow: 'hidden',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontSize: 'clamp(11px, 1.2vw, 12.5px)',
        lineHeight: 1.65,
        boxShadow:
          '0 0 0 1px rgba(185, 103, 255, 0.08), 0 24px 60px -32px rgba(255, 113, 206, 0.22), 0 8px 32px rgba(0, 0, 0, 0.6)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          borderBottom: `1px solid ${VAPOR.divider}`,
          background:
            'linear-gradient(180deg, rgba(185, 103, 255, 0.06) 0%, rgba(13, 11, 16, 0) 100%)',
        }}
      >
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: VAPOR.success,
            boxShadow: `0 0 8px ${VAPOR.success}`,
          }}
        />
        <span
          style={{
            color: VAPOR.muted,
            fontSize: '11px',
            letterSpacing: '0.04em',
          }}
        >
          $ noetic /context
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: VAPOR.placeholder,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          live
        </span>
      </div>

      <div
        style={{
          padding: '12px 16px 8px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '4px',
          borderBottom: `1px solid ${VAPOR.divider}`,
        }}
      >
        <span
          style={{
            color: VAPOR.primary,
            fontWeight: 700,
            marginRight: '0.8ch',
            letterSpacing: '0.02em',
          }}
        >
          Context Status
        </span>
        {TAB_IDS.map((id) => (
          <HeaderTab
            key={id}
            label={tabLabel(id)}
            isActive={active === id}
            onSelect={() => setActive(id)}
          />
        ))}
      </div>

      <div
        style={{
          padding: 'clamp(14px, 2.4vw, 18px) clamp(14px, 2.6vw, 20px)',
          minHeight: '320px',
          overflowX: 'auto',
        }}
      >
        {active === '__overview' ? (
          <OverviewTab />
        ) : (
          <LayerTabContent layer={LAYERS.find((l) => l.id === active) ?? LAYERS[0]!} />
        )}
      </div>
    </div>
  );
}
