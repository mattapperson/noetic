import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: React.ReactNode }): React.ReactNode {
  return <DocsLayout tree={source.pageTree}>{children}</DocsLayout>;
}
