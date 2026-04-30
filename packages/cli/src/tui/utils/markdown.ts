/**
 * Terminal markdown renderer — lexes with `marked`, walks tokens, applies
 * `chalk` styling and optional syntax highlighting.
 *
 * Ported from ~/Desktop/claude-code-main/src/utils/markdown.ts against
 * Noetic's theme. Features kept: headings, bold, italic, inline code, code
 * blocks (with optional syntax highlight), lists (ordered + unordered, nested),
 * blockquotes, paragraphs, tables, links, hr. Features dropped: OSC-8
 * hyperlink heuristics, GitHub issue linkification (deferred; not needed for
 * ask-user previews).
 */

import chalk from 'chalk';
import type { Token, Tokens } from 'marked';
import { marked } from 'marked';
import stripAnsi from 'strip-ansi';
import type { CliHighlight } from './cli-highlight.js';

//#region Configuration

const EOL = '\n';
const BLOCKQUOTE_BAR = '│';

let markedConfigured = false;

function configureMarked(): void {
  if (markedConfigured) {
    return;
  }
  markedConfigured = true;
  // Disable strikethrough — models often use ~ for "approximate" (e.g. ~100).
  marked.use({
    tokenizer: {
      del() {
        return undefined;
      },
    },
  });
}

//#endregion

//#region Public API

export interface MarkdownTheme {
  codespan: (text: string) => string;
}

const defaultTheme: MarkdownTheme = {
  codespan: (text) => chalk.cyan(text),
};

export function applyMarkdown(
  content: string,
  highlight: CliHighlight | null = null,
  theme: MarkdownTheme = defaultTheme,
): string {
  configureMarked();
  const ctx: FormatContext = {
    theme,
    highlight,
    listDepth: 0,
    orderedListNumber: null,
    parent: null,
  };
  return marked
    .lexer(content)
    .map((token) => formatToken(token, ctx))
    .join('')
    .trim();
}

//#endregion

//#region Token formatter

interface FormatContext {
  readonly theme: MarkdownTheme;
  readonly highlight: CliHighlight | null;
  readonly listDepth: number;
  readonly orderedListNumber: number | null;
  readonly parent: Token | null;
}

function withParent(ctx: FormatContext, parent: Token | null): FormatContext {
  return {
    ...ctx,
    parent,
  };
}

function withList(
  ctx: FormatContext,
  parent: Token,
  orderedListNumber: number | null,
): FormatContext {
  return {
    ...ctx,
    parent,
    orderedListNumber,
    listDepth: ctx.listDepth + 1,
  };
}

function tokenText(token: Token): string {
  return 'text' in token && typeof token.text === 'string' ? token.text : '';
}

function tokenChildren(token: Token): ReadonlyArray<Token> {
  if ('tokens' in token && Array.isArray(token.tokens)) {
    return token.tokens;
  }
  return [];
}

interface PartialTable {
  type: string;
  header?: unknown;
  rows?: unknown;
}

function isTableToken(token: Token): token is Tokens.Table {
  const candidate: PartialTable = token;
  return (
    candidate.type === 'table' && Array.isArray(candidate.header) && Array.isArray(candidate.rows)
  );
}

function renderChildren(children: ReadonlyArray<Token>, ctx: FormatContext): string {
  return children.map((t) => formatToken(t, ctx)).join('');
}

function formatToken(token: Token, ctx: FormatContext): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = renderChildren(tokenChildren(token), withParent(ctx, null));
      const bar = chalk.dim(BLOCKQUOTE_BAR);
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL);
    }
    case 'code': {
      if (!ctx.highlight) {
        return token.text + EOL;
      }
      // Pick the language only if highlight.js definitely supports it;
      // otherwise fall back to a no-highlight pass-through. Some `cli-highlight`
      // installs don't ship the `plaintext` definition, so we don't trust it
      // as a universal fallback — return the raw text instead.
      const lang = token.lang && ctx.highlight.supportsLanguage(token.lang) ? token.lang : null;
      if (lang === null) {
        return token.text + EOL;
      }
      return (
        ctx.highlight.highlight(token.text, {
          language: lang,
        }) + EOL
      );
    }
    case 'codespan':
      return ctx.theme.codespan(token.text);
    case 'em':
      return chalk.italic(renderChildren(tokenChildren(token), withParent(ctx, ctx.parent)));
    case 'strong':
      return chalk.bold(renderChildren(tokenChildren(token), withParent(ctx, ctx.parent)));
    case 'heading': {
      const inner = renderChildren(tokenChildren(token), withParent(ctx, null));
      if (token.depth === 1) {
        return chalk.bold.italic.underline(inner) + EOL + EOL;
      }
      return chalk.bold(inner) + EOL + EOL;
    }
    case 'hr':
      return `---${EOL}`;
    case 'image':
      return token.href;
    case 'link': {
      if (token.href.startsWith('mailto:')) {
        return token.href.replace(/^mailto:/, '');
      }
      const linkText = renderChildren(tokenChildren(token), withParent(ctx, token));
      const plain = stripAnsi(linkText);
      if (plain && plain !== token.href) {
        return `${linkText} (${token.href})`;
      }
      return token.href;
    }
    case 'list':
      return token.items
        .map((item: Token, index: number) => {
          const number = token.ordered ? token.start + index : null;
          return formatToken(item, {
            ...ctx,
            parent: token,
            orderedListNumber: number,
          });
        })
        .join('');
    case 'list_item':
      return tokenChildren(token)
        .map(
          (t) =>
            `${'  '.repeat(ctx.listDepth)}${formatToken(t, withList(ctx, token, ctx.orderedListNumber))}`,
        )
        .join('');
    case 'paragraph':
      return renderChildren(tokenChildren(token), withParent(ctx, null)) + EOL;
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text': {
      const children = tokenChildren(token);
      const textContent = tokenText(token);
      if (ctx.parent?.type === 'link') {
        return textContent;
      }
      if (ctx.parent?.type === 'list_item') {
        const bullet = ctx.orderedListNumber === null ? '-' : `${ctx.orderedListNumber}.`;
        const inner =
          children.length > 0 ? renderChildren(children, withParent(ctx, token)) : textContent;
        return `${bullet} ${inner}${EOL}`;
      }
      return textContent;
    }
    case 'table':
      if (isTableToken(token)) {
        return formatTable(token, ctx);
      }
      return '';
    case 'escape':
      return token.text;
    case 'def':
    case 'del':
    case 'html':
      return '';
  }
  return '';
}

//#endregion

//#region Table formatting

function formatTable(table: Tokens.Table, ctx: FormatContext): string {
  const visible = (tokens: Token[] | undefined): string =>
    stripAnsi(tokens?.map((t) => formatToken(t, withParent(ctx, null))).join('') ?? '');

  const columnWidths = table.header.map((header, index) => {
    let max = visible(header.tokens).length;
    for (const row of table.rows) {
      max = Math.max(max, visible(row[index]?.tokens).length);
    }
    return Math.max(max, 3);
  });

  let out = '| ';
  for (const [index, header] of table.header.entries()) {
    const content = header.tokens?.map((t) => formatToken(t, withParent(ctx, null))).join('') ?? '';
    const width = columnWidths[index] ?? 3;
    out += padRight(content, visible(header.tokens).length, width) + ' | ';
  }
  out = `${out.trimEnd()}${EOL}|`;
  for (const width of columnWidths) {
    out += `${'-'.repeat(width + 2)}|`;
  }
  out += EOL;

  for (const row of table.rows) {
    out += '| ';
    for (const [index, cell] of row.entries()) {
      const content = cell.tokens?.map((t) => formatToken(t, withParent(ctx, null))).join('') ?? '';
      const width = columnWidths[index] ?? 3;
      out += padRight(content, visible(cell.tokens).length, width) + ' | ';
    }
    out = `${out.trimEnd()}${EOL}`;
  }
  return out + EOL;
}

function padRight(content: string, displayWidth: number, targetWidth: number): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  return content + ' '.repeat(padding);
}

//#endregion
