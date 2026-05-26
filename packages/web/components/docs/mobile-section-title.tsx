'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const SECTIONS: Array<{
  urlPrefix: string;
  name: string;
}> = [
  {
    urlPrefix: '/docs/framework',
    name: 'Framework',
  },
  {
    urlPrefix: '/docs/code-agent-cli',
    name: 'Code Agent CLI',
  },
];

export function MobileSectionTitle(): ReactNode {
  const pathname = usePathname();
  const section = SECTIONS.find((s) => pathname.startsWith(s.urlPrefix));
  if (!section) {
    return null;
  }
  return (
    <>
      <span aria-hidden="true">&gt;</span>
      <span>{section.name}</span>
    </>
  );
}
