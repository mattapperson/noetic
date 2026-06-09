import { source } from '@/lib/source';

export const revalidate = false;

const SITE = 'https://noetic.tools';

export function GET(): Response {
  const lines: string[] = [
    '# Noetic',
    '',
    '> A TypeScript framework for building AI agents, plus a terminal-based coding agent (the Noetic Code Agent CLI). Get started: install `@noetic-tools/core`, set `OPENROUTER_API_KEY`, and run an agent in a few lines.',
    '',
    '## Documentation',
    '',
  ];

  for (const page of source.getPages()) {
    const description = page.data.description ? `: ${page.data.description}` : '';
    lines.push(`- [${page.data.title}](${SITE}${page.url})${description}`);
  }

  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
