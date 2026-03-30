'use client';

import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { WINDOW_DOT_GREEN, WINDOW_DOT_RED, WINDOW_DOT_YELLOW } from '@/lib/tui-theme';

interface TuiWindowProps {
  children: ReactNode;
  title?: string;
  className?: string;
}

function hasChildren(obj: object): obj is {
  children: unknown;
} {
  return 'children' in obj;
}

function hasProps(obj: object): obj is {
  props: object;
} {
  return 'props' in obj && obj.props !== null && typeof obj.props === 'object';
}

function extractText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('');
  }
  if (node !== null && typeof node === 'object' && hasProps(node)) {
    if (hasChildren(node.props)) {
      return extractText(node.props.children);
    }
  }
  return '';
}

export function TuiWindow({ children, title, className }: TuiWindowProps): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((): void => {
    const text = extractText(children);
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2e3);
    });
  }, [
    children,
  ]);

  return (
    <div
      className={className}
      style={{
        background: 'var(--color-tui-surface)',
        border: '1px solid var(--color-tui-border)',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '6px',
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-tui-border)',
          background: 'var(--color-tui-bg)',
        }}
      >
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: WINDOW_DOT_RED,
          }}
        />
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: WINDOW_DOT_YELLOW,
          }}
        />
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: WINDOW_DOT_GREEN,
          }}
        />
        {title && (
          <span
            style={{
              marginLeft: '8px',
              fontSize: '12px',
              color: 'var(--color-tui-muted)',
              letterSpacing: '0.05em',
            }}
          >
            {title}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          style={{
            marginLeft: 'auto',
            padding: '2px 8px',
            fontSize: '10px',
            color: copied ? 'var(--color-tui-green)' : 'var(--color-tui-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.05em',
            transition: 'color 0.15s',
          }}
        >
          {copied ? 'copied!' : 'copy'}
        </button>
      </div>
      <div
        style={{
          padding: '16px',
          fontSize: '14px',
          lineHeight: '1.6',
        }}
      >
        {children}
      </div>
    </div>
  );
}
