import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MetadataRoute } from 'next';

const SITE_URL = 'https://noetic.tools';
const DOCS_ROOT = join(process.cwd(), 'content', 'docs');

function walkMdx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walkMdx(full));
      continue;
    }
    if (entry.endsWith('.mdx')) {
      found.push(full);
    }
  }
  return found;
}

function docPath(file: string): string {
  const rel = relative(DOCS_ROOT, file)
    .replace(/\\/g, '/')
    .replace(/\.mdx$/, '');
  return rel === 'index' ? '/docs' : `/docs/${rel.replace(/\/index$/, '')}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const docUrls = walkMdx(DOCS_ROOT).map((file) => ({
    url: `${SITE_URL}${docPath(file)}`,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));

  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE_URL}/code`,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    ...docUrls,
  ];
}
