import type { ReactNode } from 'react';
import { CodeExamples } from '@/components/landing/code-examples';
import { ComingSoon } from '@/components/landing/coming-soon';
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
        <PrimitivesViz />
        <CodeExamples />
        <MemorySystem />
        <PatternsGrid />
        <ComingSoon />
      </main>
      <Footer />
    </>
  );
}
