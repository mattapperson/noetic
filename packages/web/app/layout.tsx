import { RootProvider } from 'fumadocs-ui/provider/next';
import { instrumentSerif, jetbrainsMono } from '@/lib/fonts';
import './global.css';

const SITE_URL = 'https://noetic.tools';
const SITE_NAME = 'Noetic';
const SITE_TAGLINE = 'Build AI agents you’d actually trust in production.';
const SITE_DESCRIPTION =
  'Build AI agents you’d actually trust in production. Composable TypeScript primitives, memory that keeps token costs flat, and evals that catch regressions before users do.';

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'AI agents',
    'LLM framework',
    'TypeScript',
    'agent framework',
    'AI orchestration',
    'multi-agent systems',
    'ReAct',
    'memory layers',
    'durable execution',
    'agent evals',
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
  publisher: SITE_NAME,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} — ${SITE_TAGLINE}`,
        type: 'image/png',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: [
      '/og-image.png',
    ],
  },
  icons: {
    icon: [
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

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Cross-platform',
      description: SITE_DESCRIPTION,
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      programmingLanguage: 'TypeScript',
      codeRepository: 'https://github.com/mattapperson/noetic',
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <html
      lang="en"
      className={`${jetbrainsMono.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <body
        style={{
          fontFamily: 'var(--font-mono), monospace',
          background: 'var(--color-tui-bg)',
          color: 'var(--color-tui-fg)',
        }}
      >
        <script type="application/ld+json">{JSON.stringify(JSON_LD)}</script>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
