import { RootProvider } from 'fumadocs-ui/provider/next';
import { jetbrainsMono } from '@/lib/fonts';
import './global.css';

export const metadata = {
  title: {
    default: 'Noetic — Agent Framework',
    template: '%s | Noetic',
  },
  description:
    'Build AI agents with composable primitives. ReAct patterns, memory management, and multi-agent workflows in clean TypeScript.',
  keywords: [
    'AI agents',
    'LLM framework',
    'ReAct',
    'TypeScript',
    'agent framework',
    'AI orchestration',
    'multi-agent systems',
  ],
  authors: [
    {
      name: 'Matt Apperson',
    },
    {
      name: 'Ian White',
    },
  ],
  creator: 'Matt Apperson',
  publisher: 'Noetic',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://noetic.tools',
    siteName: 'Noetic',
    title: 'Noetic — Agent Framework',
    description:
      'Build AI agents with composable primitives. ReAct patterns, memory management, and multi-agent workflows in clean TypeScript.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Noetic Agent Framework',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Noetic — Agent Framework',
    description:
      'Build AI agents with composable primitives. ReAct patterns, memory management, and multi-agent workflows in clean TypeScript.',
    images: [
      '/og-image.png',
    ],
  },
  icons: {
    icon: [
      {
        url: '/favicon.ico',
        sizes: 'any',
      },
      {
        url: '/favicon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: [
      {
        url: '/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  },
  manifest: '/manifest.json',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    {
      media: '(prefers-color-scheme: dark)',
      color: '#050505',
    },
    {
      media: '(prefers-color-scheme: light)',
      color: '#050505',
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <body
        style={{
          fontFamily: 'var(--font-mono), monospace',
          background: 'var(--color-tui-bg)',
          color: 'var(--color-tui-fg)',
        }}
      >
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
