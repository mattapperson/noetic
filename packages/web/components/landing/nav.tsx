'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { GITHUB_URL, NAV_BG, NAV_LINK_STYLE } from '@/lib/tui-theme';

export function Nav(): ReactNode {
  return (
    <nav
      style={{
        position: 'fixed',
        top: 0,
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
        ORCHID
      </Link>
      <div
        style={{
          display: 'flex',
          gap: '24px',
          alignItems: 'center',
        }}
      >
        <Link href="/docs" style={NAV_LINK_STYLE}>
          Docs
        </Link>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={NAV_LINK_STYLE}>
          GitHub
        </a>
      </div>
    </nav>
  );
}
