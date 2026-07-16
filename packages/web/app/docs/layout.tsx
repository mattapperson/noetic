import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsIndexLink } from '@/components/docs/docs-index-link';
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
      links={[
        {
          text: 'Platform',
          url: '/platform',
        },
        {
          text: 'Code',
          url: '/code',
        },
      ]}
      sidebar={{
        banner: <DocsIndexLink />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
