import type { ReactNode } from 'react';
import { CodePeek } from '@/components/landing/code-peek';
import { Differentiation } from '@/components/landing/differentiation';
import { Endurance } from '@/components/landing/endurance';
import { EvalFramework } from '@/components/landing/eval-framework';
import { Footer } from '@/components/landing/footer';
import { Hero } from '@/components/landing/hero';
import { MemorySystem } from '@/components/landing/memory-system';
import { Nav } from '@/components/landing/nav';
import { PatternsGrid } from '@/components/landing/patterns-grid';
import { PillarHeader } from '@/components/landing/pillar-header';
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
          <PillarHeader id="compose" index="01" name="Compose" />
          <PrimitivesViz />
          <PatternsGrid />
          <CodePeek />

          <PillarHeader id="remember" index="02" name="Remember" />
          <MemorySystem />

          <PillarHeader id="endure" index="03" name="Endure" />
          <Endurance />

          <PillarHeader id="prove" index="04" name="Prove" />
          <EvalFramework />

          <Differentiation />
        </div>
      </main>
      <Footer />
    </>
  );
}
