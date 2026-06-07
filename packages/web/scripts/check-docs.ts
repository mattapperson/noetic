/**
 * Validates the TypeScript/TSX code fences in the docs site with Kiira.
 *
 * Two things make this a thin custom runner rather than the stock `kiira check`:
 *
 *  1. Kiira's CLI only discovers files ending in `.md` (kiira-core
 *     `discoverMarkdownFiles`), so it silently skips this site's `.mdx` content.
 *     We glob the `.mdx` files ourselves and run kiira-core's pipeline on them.
 *
 *  2. The shared import/declaration preamble must be applied *conditionally*.
 *     Bare snippet fences reference builders (`step`, `react`, …) and stand-in
 *     symbols (`searchTool`, `agent`, …) without importing them, so they need
 *     the preamble. Self-contained example fences already import from
 *     `@noetic-tools/*`; injecting the preamble there would collide (TS2300
 *     duplicate identifier). Kiira's `defaultFixture` is unconditional, so we
 *     tag each bare snippet with the `noetic` fixture per-snippet and let
 *     kiira-core's `createVirtualFiles` apply it.
 *
 * Usage: bun scripts/check-docs.ts [--json]
 * Exit codes: 0 = no errors, 1 = validation errors, 2 = runtime failure.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractedSnippet, KiiraConfig, KiiraDiagnostic } from 'kiira-core';
import {
  checkVirtualFiles,
  createVirtualFiles,
  extractSnippetsFromContent,
  resolveConfig,
} from 'kiira-core';
import baseConfig from '../kiira.config';
import { DOC_PREAMBLE } from './doc-preamble';

const WEB_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const JSON_MODE = process.argv.includes('--json');
const PREAMBLE_FIXTURE = 'noetic';
/** Positional args restrict checking to files whose path contains one of these substrings. */
const FILE_FILTERS = process.argv.slice(2).filter((arg) => arg.length > 0 && !arg.startsWith('--'));

/** Config with the preamble fixture registered (the runner owns the fixture). */
const config: KiiraConfig = {
  ...baseConfig,
  fixtures: {
    ...baseConfig.fixtures,
    [PREAMBLE_FIXTURE]: {
      type: 'prepend',
      content: DOC_PREAMBLE,
    },
  },
};

/** Any import from a @noetic-tools/* or @noetic/* package means the fence is self-contained. */
const SELF_IMPORT_RE = /from\s+['"]@noetic(?:-tools)?\/[^'"]+['"]/;

/**
 * A fence that imports from a Noetic package brings its own symbols and is
 * checked standalone; everything else gets the shared preamble fixture. A fence
 * with an explicit `fixture=` meta is left untouched.
 */
function tagFixture(snippet: ExtractedSnippet): ExtractedSnippet {
  if (snippet.meta.fixture || SELF_IMPORT_RE.test(snippet.code)) {
    return snippet;
  }
  return {
    ...snippet,
    meta: {
      ...snippet.meta,
      fixture: PREAMBLE_FIXTURE,
    },
  };
}

function severityRank(diag: KiiraDiagnostic): number {
  if (diag.severity === 'error') {
    return 0;
  }
  if (diag.severity === 'warning') {
    return 1;
  }
  return 2;
}

function formatDiagnostic(diag: KiiraDiagnostic): string {
  const line = diag.markdownRange.start.line + 1;
  const col = diag.markdownRange.start.character + 1;
  const code = diag.code === undefined ? '' : ` ${diag.source}(${diag.code})`;
  const where = `${diag.markdownFile}:${line}:${col}`;
  return `  ${diag.severity.toUpperCase()} ${where}${code}\n    ${diag.message.replace(/\n/g, '\n    ')}`;
}

async function collectMdxFiles(): Promise<string[]> {
  const glob = new Bun.Glob('content/**/*.mdx');
  const files: string[] = [];
  for await (const file of glob.scan({
    cwd: WEB_DIR,
  })) {
    if (FILE_FILTERS.length === 0 || FILE_FILTERS.some((f) => file.includes(f))) {
      files.push(file);
    }
  }
  return files.sort();
}

async function main(): Promise<number> {
  const resolved = resolveConfig(config);
  const files = await collectMdxFiles();

  if (files.length === 0) {
    const reason =
      FILE_FILTERS.length > 0
        ? 'No .mdx files matched the given filter.'
        : 'No .mdx files found under content/.';
    console.error(`${reason} Nothing to check.`);
    return 2;
  }

  const snippets: ExtractedSnippet[] = [];
  const diagnostics: KiiraDiagnostic[] = [];

  const extractions = await Promise.all(
    files.map(async (file) => {
      const content = await Bun.file(path.join(WEB_DIR, file)).text();
      return extractSnippetsFromContent({
        markdownFile: file,
        content,
        config: resolved,
      });
    }),
  );
  for (const extraction of extractions) {
    diagnostics.push(...extraction.diagnostics);
    snippets.push(...extraction.snippets.map(tagFixture));
  }

  const { virtualFiles, diagnostics: fixtureDiagnostics } = await createVirtualFiles({
    cwd: WEB_DIR,
    snippets,
    config,
  });
  diagnostics.push(...fixtureDiagnostics);
  diagnostics.push(
    ...(await checkVirtualFiles({
      cwd: WEB_DIR,
      virtualFiles,
      config,
    })),
  );

  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') {
      errors++;
    } else if (d.severity === 'warning') {
      warnings++;
    }
  }

  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        {
          diagnostics,
          stats: {
            files: files.length,
            snippets: snippets.length,
            checked: virtualFiles.length,
            errors,
            warnings,
          },
        },
        null,
        2,
      ),
    );
    return errors > 0 ? 1 : 0;
  }

  const sorted = diagnostics.sort((a, b) => {
    const bySeverity = severityRank(a) - severityRank(b);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return a.markdownFile.localeCompare(b.markdownFile);
  });

  for (const diag of sorted) {
    const out = diag.severity === 'error' ? console.error : console.warn;
    out(formatDiagnostic(diag));
  }

  const ignored = snippets.length - virtualFiles.length;
  const summary = `Kiira checked ${snippets.length} snippets in ${files.length} files (${virtualFiles.length} type-checked, ${ignored} ignored).`;
  if (errors > 0) {
    console.error(`\n✗ ${summary} ${errors} error(s), ${warnings} warning(s).`);
    return 1;
  }
  console.log(`\n✓ ${summary} 0 errors, ${warnings} warning(s).`);
  return 0;
}

main()
  .then((code) => {
    // Set exitCode rather than calling process.exit(), so buffered stdout/stderr
    // (hundreds of diagnostic lines) is fully flushed before the process exits.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('kiira check-docs failed:', error);
    process.exitCode = 2;
  });
