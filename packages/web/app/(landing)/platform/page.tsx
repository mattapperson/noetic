import type { ReactNode } from 'react';
import { Footer } from '@/components/landing/footer';
import { Nav } from '@/components/landing/nav';
import { PlatformHero } from '@/components/landing/platform/platform-hero';
import { PlatformInside } from '@/components/landing/platform/platform-inside';
import { PlatformLoop } from '@/components/landing/platform/platform-loop';

const PLATFORM_TITLE = 'Noetic Platform';
const PLATFORM_DESCRIPTION =
  'The holistic agent platform: build agents in TypeScript or plain language, run them durably in the cloud or on your own machines, observe every step, prove them with evals, improve them with GEPA, and operate them with permissions, metering, and billing — if you want it.';

export const metadata = {
  title: PLATFORM_TITLE,
  description: PLATFORM_DESCRIPTION,
  alternates: {
    canonical: '/platform',
  },
  openGraph: {
    title: PLATFORM_TITLE,
    description: PLATFORM_DESCRIPTION,
    url: '/platform',
    type: 'website',
    siteName: 'Noetic',
    locale: 'en_US',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Noetic Platform — the whole agent lifecycle, one stack',
        type: 'image/png',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: PLATFORM_TITLE,
    description: PLATFORM_DESCRIPTION,
    images: [
      '/og-image.png',
    ],
  },
};

export default function PlatformPage(): ReactNode {
  return (
    <>
      <Nav />
      <main>
        <PlatformHero />
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            background: 'var(--color-tui-bg)',
          }}
        >
          <PlatformLoop />
          <PlatformInside />
        </div>
      </main>
      <Footer />
    </>
  );
}
