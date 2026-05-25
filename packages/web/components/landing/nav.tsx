'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { GITHUB_URL, NAV_BG, NAV_LINK_STYLE } from '@/lib/tui-theme';

export function Nav(): ReactNode {
  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 51,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '6px 16px',
          background: 'rgba(245, 158, 11, 0.1)',
          borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
          fontSize: '12px',
          letterSpacing: '0.05em',
          color: 'rgb(245, 158, 11)',
        }}
      >
        <span
          style={{
            fontWeight: 700,
          }}
        >
          Noetic Code CLI
        </span>
        <span
          style={{
            color: 'var(--color-tui-muted)',
          }}
        >
          {' '}
          —{' '}
        </span>
        <span>AI coding agent with 10 memory layers. Coming soon.</span>
        <Link
          href="/code"
          style={{
            marginLeft: '8px',
            padding: '2px 8px',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            borderRadius: '3px',
            fontSize: '11px',
            fontWeight: 600,
            color: 'rgb(245, 158, 11)',
            textDecoration: 'none',
          }}
        >
          Learn more
        </Link>
      </div>
      <nav
        style={{
          position: 'fixed',
          top: '30px',
          left: 0,
          right: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--color-tui-border)',
          background: NAV_BG,
        }}
      >
        <Link
          href="/"
          style={{
            fontSize: '14px',
            fontWeight: 700,
            color: 'var(--color-tui-green)',
            textDecoration: 'none',
            letterSpacing: '0.1em',
          }}
        >
          NOETIC
        </Link>
        <div
          style={{
            display: 'flex',
            gap: '24px',
            alignItems: 'center',
          }}
        >
          <Link href="/code" style={NAV_LINK_STYLE}>
            Code
          </Link>
          <Link href="/docs" style={NAV_LINK_STYLE}>
            Docs
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={NAV_LINK_STYLE}>
            GitHub
          </a>
        </div>
      </nav>
    </>
  );
}
