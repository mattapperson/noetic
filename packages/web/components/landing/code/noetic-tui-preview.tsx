'use client';

import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

const VAPOR = {
  bg: '#0D0B10',
  fg: '#F0E6FF',
  muted: '#A69CBD',
  placeholder: '#7C7290',
  primary: '#FF71CE',
  accent: '#01CDFE',
  secondary: '#B967FF',
  success: '#05FFA1',
  warning: '#FFC164',
  border: '#3a2d4d',
  divider: '#2a1f3a',
} as const;

interface TranscriptLine {
  kind: 'user' | 'tool-call' | 'tool-result' | 'agent-text' | 'spinner';
  text: ReactNode;
}

const TRANSCRIPT: TranscriptLine[] = [
  {
    kind: 'user',
    text: '/plan add dark-mode toggle',
  },
  {
    kind: 'tool-result',
    text: '/plan opened',
  },
  {
    kind: 'agent-text',
    text: (
      <>
        Routing the work:{' '}
        <span
          style={{
            color: VAPOR.warning,
          }}
        >
          planner
        </span>
        =sonnet ·{' '}
        <span
          style={{
            color: VAPOR.warning,
          }}
        >
          editor
        </span>
        =opus ·{' '}
        <span
          style={{
            color: VAPOR.warning,
          }}
        >
          reviewer
        </span>
        =haiku.
      </>
    ),
  },
  {
    kind: 'tool-call',
    text: (
      <>
        Read(
        <span
          style={{
            color: VAPOR.accent,
          }}
        >
          README.md
        </span>
        ,{' '}
        <span
          style={{
            color: VAPOR.accent,
          }}
        >
          theme.tsx
        </span>
        )
      </>
    ),
  },
  {
    kind: 'tool-result',
    text: 'scanned 487 lines · 2 files',
  },
  {
    kind: 'tool-call',
    text: (
      <>
        Spawn(
        <span
          style={{
            color: VAPOR.accent,
          }}
        >
          refactor-bot
        </span>
        ) → worktree
      </>
    ),
  },
  {
    kind: 'spinner',
    text: 'Pondering... · 12s · ↑ 1.2k ↓ 380 · 1.4 tok/s',
  },
];

const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠸',
  '⠴',
  '⠦',
  '⠇',
] as const;

function renderLine(line: TranscriptLine, key: number): ReactNode {
  if (line.kind === 'user') {
    return (
      <div key={key} style={lineRowStyle}>
        <span
          style={{
            color: VAPOR.secondary,
            width: '2ch',
            flexShrink: 0,
          }}
        >
          ❯
        </span>
        <span
          style={{
            color: VAPOR.fg,
          }}
        >
          {line.text}
        </span>
      </div>
    );
  }
  if (line.kind === 'tool-call') {
    return (
      <div key={key} style={lineRowStyle}>
        <span
          style={{
            color: VAPOR.primary,
            width: '2ch',
            flexShrink: 0,
          }}
        >
          ⏺
        </span>
        <span
          style={{
            color: VAPOR.fg,
          }}
        >
          {line.text}
        </span>
      </div>
    );
  }
  if (line.kind === 'tool-result') {
    return (
      <div key={key} style={lineRowStyle}>
        <span
          style={{
            color: VAPOR.muted,
            width: '2ch',
            flexShrink: 0,
            textAlign: 'right',
            paddingRight: '0.6ch',
          }}
        >
          ⎿
        </span>
        <span
          style={{
            color: VAPOR.muted,
          }}
        >
          {line.text}
        </span>
      </div>
    );
  }
  if (line.kind === 'agent-text') {
    return (
      <div key={key} style={lineRowStyle}>
        <span
          style={{
            width: '2ch',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: VAPOR.fg,
          }}
        >
          {line.text}
        </span>
      </div>
    );
  }
  return (
    <div key={key} style={lineRowStyle}>
      <span
        className="noetic-tui-spinner"
        style={{
          color: VAPOR.accent,
          width: '2ch',
          flexShrink: 0,
        }}
      >
        {SPINNER_FRAMES[2]}
      </span>
      <span
        style={{
          color: VAPOR.muted,
        }}
      >
        {line.text}
      </span>
    </div>
  );
}

const lineRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0',
};

interface PowerlineSegment {
  glyph: string;
  text: string;
  color: string;
}

const POWERLINE: PowerlineSegment[] = [
  {
    glyph: 'N',
    text: '',
    color: VAPOR.primary,
  },
  {
    glyph: '*',
    text: 'claude-sonnet-4',
    color: VAPOR.accent,
  },
  {
    glyph: '~',
    text: '~/my-project',
    color: VAPOR.secondary,
  },
  {
    glyph: '±',
    text: 'main*',
    color: VAPOR.success,
  },
];

function PowerlineBar(): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6ch',
        padding: '0 1ch',
        flexWrap: 'nowrap',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {POWERLINE.map((seg, i) => (
        <span
          key={`${seg.glyph}-${seg.text}`}
          style={{
            display: 'inline-flex',
            gap: '0.6ch',
            alignItems: 'baseline',
          }}
        >
          {i > 0 && (
            <span
              style={{
                color: VAPOR.muted,
                opacity: 0.55,
              }}
            >
              {'>'}
            </span>
          )}
          <span
            style={{
              color: seg.color,
              fontWeight: 700,
            }}
          >
            {seg.glyph}
          </span>
          {seg.text && (
            <span
              style={{
                color: VAPOR.fg,
              }}
            >
              {seg.text}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function Divider(): ReactNode {
  return (
    <div
      aria-hidden
      style={{
        height: '1px',
        background: VAPOR.divider,
        margin: '0',
      }}
    />
  );
}

interface NoeticTuiPreviewProps {
  title?: string;
  badgeText?: string;
}

export function NoeticTuiPreview({
  title = '~/my-project — noetic',
  badgeText = 'detached · 47m',
}: NoeticTuiPreviewProps): ReactNode {
  return (
    <motion.div
      initial={{
        opacity: 0,
        scale: 0.98,
      }}
      animate={{
        opacity: 1,
        scale: 1,
      }}
      transition={{
        duration: 0.5,
      }}
      style={{
        background: VAPOR.bg,
        border: `1px solid ${VAPOR.border}`,
        borderRadius: '6px',
        overflow: 'hidden',
        fontFamily: 'var(--font-mono), ui-monospace, monospace',
        fontSize: 'clamp(11px, 1.55vw, 13px)',
        lineHeight: 1.65,
        boxShadow:
          '0 0 0 1px rgba(185, 103, 255, 0.08), 0 28px 80px -32px rgba(255, 113, 206, 0.28), 0 8px 32px rgba(0, 0, 0, 0.6)',
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
          {title}
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
          {badgeText}
        </span>
      </div>

      <div
        style={{
          padding: 'clamp(14px, 2.4vw, 18px) clamp(14px, 2.6vw, 20px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.15em',
          color: VAPOR.fg,
        }}
      >
        {TRANSCRIPT.map((line, i) => renderLine(line, i))}
      </div>

      <Divider />

      <div
        style={{
          padding: 'clamp(8px, 1.4vw, 10px) 0',
          fontSize: 'clamp(11px, 1.5vw, 12.5px)',
        }}
      >
        <PowerlineBar />
      </div>

      <Divider />

      <div
        style={{
          padding: 'clamp(10px, 2vw, 14px) clamp(14px, 2.6vw, 20px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.8ch',
          }}
        >
          <span
            style={{
              color: VAPOR.secondary,
              fontWeight: 700,
            }}
          >
            ❯
          </span>
          <span
            style={{
              color: VAPOR.placeholder,
            }}
          >
            Type a message…
          </span>
          <span
            className="tui-cursor"
            style={{
              display: 'inline-block',
              width: '0.55ch',
              height: '1em',
              background: VAPOR.secondary,
              marginLeft: '0.2ch',
              transform: 'translateY(0.12em)',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.8ch',
            fontSize: '0.92em',
          }}
        >
          <span
            style={{
              padding: '1px 6px',
              border: `1px solid ${VAPOR.secondary}`,
              color: VAPOR.secondary,
              fontSize: '0.78em',
              letterSpacing: '0.16em',
              borderRadius: '2px',
              fontWeight: 700,
            }}
          >
            ACT
          </span>
          <span
            style={{
              color: VAPOR.muted,
            }}
          >
            anthropic/claude-sonnet-4
          </span>
        </div>
      </div>

      <Divider />
    </motion.div>
  );
}
