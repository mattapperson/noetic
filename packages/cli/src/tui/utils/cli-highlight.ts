/**
 * Thin wrapper around the `cli-highlight` npm package — provides syntax
 * highlighting for code blocks with a small feature probe the markdown
 * renderer can use to fall back to plaintext on unsupported languages.
 */

import { highlight, supportsLanguage } from 'cli-highlight';

export interface HighlightOptions {
  language: string;
}

export interface CliHighlight {
  highlight(code: string, options: HighlightOptions): string;
  supportsLanguage(language: string): boolean;
}

export function createCliHighlight(): CliHighlight {
  return {
    highlight(code, options) {
      return highlight(code, {
        language: options.language,
        ignoreIllegals: true,
      });
    },
    supportsLanguage(language) {
      return supportsLanguage(language);
    },
  };
}
