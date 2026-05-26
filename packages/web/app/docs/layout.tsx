import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import Link from 'next/link';
import { MobileSectionTitle } from '@/components/docs/mobile-section-title';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: 'NOETIC',
        url: '/',
        children: <MobileSectionTitle />,
      }}
      sidebar={{
        banner: (
          <Link href="/docs" className="docs-index-link">
            ← Docs index
          </Link>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
