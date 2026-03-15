'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FOOTER_RULE, GITHUB_URL, NAV_LINK_STYLE } from '@/lib/tui-theme';

const INSTALL_CMD = 'npm install @noetic/core';
const COPY_FEEDBACK_MS = 2e3;

export function Footer(): ReactNode {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback((): void => {
    navigator.clipboard.writeText(INSTALL_CMD).catch((): void => {});
    setCopied(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout((): void => setCopied(false), COPY_FEEDBACK_MS);
  }, []);

  return (
    <footer
      style={{
        padding: '40px 24px',
        borderTop: '1px solid var(--color-tui-border)',
      }}
    >
      <div
        style={{
          maxWidth: '960px',
          margin: '0 auto',
        }}
      >
        <pre
          style={{
            color: 'var(--color-tui-border)',
            fontSize: '12px',
            margin: '0 0 24px',
            overflow: 'hidden',
          }}
        >
          {FOOTER_RULE}
        </pre>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '16px',
          }}
        >
          <button
            type="button"
            onClick={handleCopy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              background: 'var(--color-tui-surface)',
              border: '1px solid var(--color-tui-border)',
              borderRadius: '4px',
              color: 'var(--color-tui-secondary)',
              fontSize: '13px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span
              style={{
                color: 'var(--color-tui-green)',
                fontWeight: 700,
              }}
            >
              $
            </span>
            {INSTALL_CMD}
            <span
              style={{
                color: 'var(--color-tui-muted)',
                fontSize: '11px',
                marginLeft: '8px',
              }}
            >
              {copied ? 'copied!' : 'click to copy'}
            </span>
          </button>

          <div
            style={{
              display: 'flex',
              gap: '24px',
            }}
          >
            <Link href="/docs" style={NAV_LINK_STYLE}>
              Docs
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={NAV_LINK_STYLE}>
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/@noetic/core"
              target="_blank"
              rel="noopener noreferrer"
              style={NAV_LINK_STYLE}
            >
              npm
            </a>
          </div>
        </div>

        <p
          style={{
            fontSize: '11px',
            color: 'var(--color-tui-muted)',
            margin: '24px 0 0',
            textAlign: 'center',
          }}
        >
          Built with Noetic, Next.js, and fumadocs
        </p>
      </div>
    </footer>
  );
}
