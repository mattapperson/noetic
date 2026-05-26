import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { MobileSectionTitle } from '@/components/docs/mobile-section-title';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: <MobileSectionTitle />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
