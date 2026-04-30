import type { ReactNode } from 'react';

const STATE_COLOR = {
  running: 'var(--color-tui-green)',
  idle: 'var(--color-tui-amber)',
  done: 'var(--color-tui-cyan)',
} as const;

type LiveState = keyof typeof STATE_COLOR;

interface LiveDotProps {
  state: LiveState;
  size?: number;
}

export function LiveDot({ state, size = 8 }: LiveDotProps): ReactNode {
  const color = STATE_COLOR[state];
  const isLive = state === 'running';

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size + 6}px`,
        height: `${size + 6}px`,
      }}
    >
      {isLive && (
        <span
          className="tui-pulse"
          style={{
            position: 'absolute',
            width: `${size + 6}px`,
            height: `${size + 6}px`,
            borderRadius: '50%',
            background: color,
            opacity: 0.25,
          }}
        />
      )}
      <span
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 8px ${color}`,
        }}
      />
    </span>
  );
}
