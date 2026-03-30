import type { ReactNode } from 'react';
import { CodePeek } from '@/components/landing/code-peek';
import { ComingSoon } from '@/components/landing/coming-soon';
import { Differentiation } from '@/components/landing/differentiation';
import { Footer } from '@/components/landing/footer';
import { Hero } from '@/components/landing/hero';
import { MemorySystem } from '@/components/landing/memory-system';
import { Nav } from '@/components/landing/nav';
import { PatternsGrid } from '@/components/landing/patterns-grid';
import { PrimitivesViz } from '@/components/landing/primitives-viz';

export default function LandingPage(): ReactNode {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            background: 'var(--color-tui-bg)',
          }}
        >
          <PrimitivesViz />
          <MemorySystem />
          <PatternsGrid />
          <CodePeek />
          <Differentiation />
          <ComingSoon />
        </div>
      </main>
      <Footer />
    </>
  );
}
