import type { ReactNode } from 'react';
import { CodeBackgroundAgents } from '@/components/landing/code/code-background-agents';
import { CodeBenchmarks } from '@/components/landing/code/code-benchmarks';
import { CodeContextManager } from '@/components/landing/code/code-context-manager';
import { CodeHero } from '@/components/landing/code/code-hero';
import { CodeMultiModel } from '@/components/landing/code/code-multi-model';
import { Footer } from '@/components/landing/footer';
import { Nav } from '@/components/landing/nav';

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
          <CodeContextManager />
          <CodeBackgroundAgents />
          <CodeMultiModel />
        </div>
      </main>
      <Footer />
    </>
  );
}
