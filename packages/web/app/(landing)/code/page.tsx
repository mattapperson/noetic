import type { ReactNode } from 'react';
import { CodeBackgroundAgents } from '@/components/landing/code/code-background-agents';
import { CodeBenchmarks } from '@/components/landing/code/code-benchmarks';
import { CodeEverywhere } from '@/components/landing/code/code-everywhere';
import { CodeContextManager } from '@/components/landing/code/code-context-manager';
import { CodeHero } from '@/components/landing/code/code-hero';
import { CodeMultiModel } from '@/components/landing/code/code-multi-model';
import { Footer } from '@/components/landing/footer';
import { Nav } from '@/components/landing/nav';

const CODE_TITLE = 'Noetic Code';
const CODE_DESCRIPTION =
  'An AI coding agent built on Noetic — in your terminal, on your Mac and iPhone, and in the cloud. Durable sessions, background agents, multi-model routing, and ten memory layers. Coming soon.';

export const metadata = {
  title: CODE_TITLE,
  description: CODE_DESCRIPTION,
  alternates: {
    canonical: '/code',
  },
  openGraph: {
    title: CODE_TITLE,
    description: CODE_DESCRIPTION,
    url: '/code',
    type: 'website',
    siteName: 'Noetic',
    locale: 'en_US',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Noetic Code — the AI coding agent for terminal, desktop, mobile, and cloud',
        type: 'image/png',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: CODE_TITLE,
    description: CODE_DESCRIPTION,
    images: [
      '/og-image.png',
    ],
  },
};

export default function CodePage(): ReactNode {
  return (
    <>
      <Nav />
      <main>
        <CodeHero />
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            background: 'var(--color-tui-bg)',
          }}
        >
          <CodeBenchmarks />
          <CodeEverywhere />
          <CodeContextManager />
          <CodeBackgroundAgents />
          <CodeMultiModel />
        </div>
      </main>
      <Footer />
    </>
  );
}
