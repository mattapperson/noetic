'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function DocsIndexLink(): ReactNode {
  const pathname = usePathname();
  if (pathname === '/docs') {
    return null;
  }
  return (
    <Link href="/docs" className="docs-index-link">
      ← Docs index
    </Link>
  );
}
