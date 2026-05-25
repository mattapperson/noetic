'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { GITHUB_URL } from '@/lib/tui-theme';

export function Nav(): ReactNode {
  return (
    <>
      <div className="announcement-banner">
        <span className="banner-title">Noetic Code CLI</span>
        <span className="banner-separator"> — </span>
        <span className="banner-description">
          AI coding agent with 10 memory layers. Coming soon.
        </span>
        <Link href="/code" className="banner-link">
          Learn more
        </Link>
      </div>
      <nav className="site-nav">
        <Link href="/" className="nav-brand">
          NOETIC
        </Link>
        <div className="nav-links">
          <Link href="/code" className="nav-link">
            Code
          </Link>
          <Link href="/docs" className="nav-link">
            Docs
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="nav-link">
            GitHub
          </a>
        </div>
      </nav>
    </>
  );
}
