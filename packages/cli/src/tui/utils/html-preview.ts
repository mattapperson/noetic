/**
 * HTML preview renderer — accepts HTML fragments and converts them to
 * terminal-styled text, rejecting inputs that contain `<script>`, `<style>`,
 * or wrap a full document (`<html>`, `<body>`).
 *
 * Ported from the reference `PreviewBox.tsx` HTML validator path. Uses
 * `html-to-text` for the heavy lifting.
 *
 * The tag-name blocklist below is best-effort guidance to the LLM and a
 * cheap reject for obvious misuse. The real safety guarantee is the
 * post-render scrub: any ANSI escape sequences or C0 control characters in
 * the input survive `html-to-text` unchanged, so we strip them ourselves
 * before returning. Otherwise a hostile preview could move the cursor,
 * change colors, or otherwise corrupt the terminal frame.
 */

import { convert } from 'html-to-text';
import stripAnsi from 'strip-ansi';

//#region Validation

export class HtmlPreviewRejectedError extends Error {
  readonly kind = 'html-preview-rejected' as const;
  constructor(reason: string) {
    super(`HTML preview rejected: ${reason}`);
    this.name = 'HtmlPreviewRejectedError';
  }
}

const FORBIDDEN_TAG_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /<script\b/i,
    reason: 'script tags are not allowed',
  },
  {
    pattern: /<style\b/i,
    reason: 'style tags are not allowed',
  },
  {
    pattern: /<html\b/i,
    reason: 'full-document HTML is not allowed; pass a fragment',
  },
  {
    pattern: /<body\b/i,
    reason: 'full-document HTML is not allowed; pass a fragment',
  },
  {
    pattern: /<head\b/i,
    reason: 'full-document HTML is not allowed; pass a fragment',
  },
  {
    pattern: /<iframe\b/i,
    reason: 'iframes are not allowed',
  },
  {
    pattern: /<object\b/i,
    reason: 'object tags are not allowed',
  },
  {
    pattern: /<embed\b/i,
    reason: 'embed tags are not allowed',
  },
];

function validateHtmlFragment(html: string): void {
  for (const { pattern, reason } of FORBIDDEN_TAG_PATTERNS) {
    if (pattern.test(html)) {
      throw new HtmlPreviewRejectedError(reason);
    }
  }
}

//#endregion

//#region Sanitisation

// Strip C0 control chars (U+0000–U+001F) and DEL (U+007F) from the rendered
// text, but keep newline (\n = U+000A) and tab (\t = U+0009) which are
// legitimate whitespace. The control chars are exactly what we're trying
// to detect, so silence the rule that would flag the regex.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char strip
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function scrubTerminalEscapes(text: string): string {
  return stripAnsi(text).replace(CONTROL_CHARS, '');
}

//#endregion

//#region Public API

export function renderHtmlPreview(html: string): string {
  validateHtmlFragment(html);
  const rendered = convert(html, {
    wordwrap: false,
    selectors: [
      {
        selector: 'a',
        options: {
          ignoreHref: false,
        },
      },
      {
        selector: 'img',
        format: 'skip',
      },
    ],
  });
  return scrubTerminalEscapes(rendered);
}

export function looksLikeHtml(value: string): boolean {
  return /<[a-zA-Z][^>]*>/.test(value);
}

//#endregion
