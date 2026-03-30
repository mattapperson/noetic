import type { CSSProperties, ReactNode } from 'react';

interface Token {
  text: string;
  type: 'keyword' | 'string' | 'comment' | 'function' | 'type' | 'operator' | 'default';
}

const KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'class',
  'interface',
  'type',
  'return',
  'await',
  'async',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'this',
  'extends',
  'implements',
  'as',
  'is',
  'in',
  'of',
  'try',
  'catch',
  'finally',
  'throw',
  'true',
  'false',
  'null',
  'undefined',
]);

const TYPES = new Set([
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'never',
  'void',
  'object',
  'Record',
  'Array',
  'Promise',
  'Map',
  'Set',
  'Context',
  'Step',
  'Runtime',
]);

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    const char = code[i];

    // Comments
    if (char === '/' && code[i + 1] === '/') {
      let comment = '';
      while (i < code.length && code[i] !== '\n') {
        comment += code[i];
        i++;
      }
      tokens.push({
        text: comment,
        type: 'comment',
      });
      continue;
    }

    // Strings (single and double quotes, template literals)
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let str = char;
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') {
          str += code[i] + code[i + 1];
          i += 2;
        } else {
          str += code[i];
          i++;
        }
      }
      if (i < code.length) {
        str += code[i];
        i++;
      }
      tokens.push({
        text: str,
        type: 'string',
      });
      continue;
    }

    // Whitespace
    if (/\s/.test(char)) {
      let whitespace = '';
      while (i < code.length && /\s/.test(code[i])) {
        whitespace += code[i];
        i++;
      }
      tokens.push({
        text: whitespace,
        type: 'default',
      });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(char)) {
      let word = '';
      while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) {
        word += code[i];
        i++;
      }

      if (KEYWORDS.has(word)) {
        tokens.push({
          text: word,
          type: 'keyword',
        });
      } else if (TYPES.has(word) || /^[A-Z]/.test(word)) {
        tokens.push({
          text: word,
          type: 'type',
        });
      } else {
        tokens.push({
          text: word,
          type: 'default',
        });
      }
      continue;
    }

    // Operators and punctuation
    if (/[=+\-*/<>!&|:;.,?()[\]{}]/.test(char)) {
      tokens.push({
        text: char,
        type: 'operator',
      });
      i++;
      continue;
    }

    // Numbers
    if (/\d/.test(char)) {
      let num = '';
      while (i < code.length && /[\d.]/.test(code[i])) {
        num += code[i];
        i++;
      }
      tokens.push({
        text: num,
        type: 'default',
      });
      continue;
    }

    // Default case
    tokens.push({
      text: char,
      type: 'default',
    });
    i++;
  }

  return tokens;
}

const TOKEN_STYLES: Record<Token['type'], CSSProperties> = {
  keyword: {
    color: 'var(--color-tui-cyan)',
  },
  string: {
    color: 'var(--color-tui-green)',
  },
  comment: {
    color: 'var(--color-tui-muted)',
  },
  function: {
    color: 'var(--color-tui-amber)',
  },
  type: {
    color: 'var(--color-tui-amber)',
  },
  operator: {
    color: 'var(--color-tui-fg)',
  },
  default: {
    color: 'var(--color-tui-secondary)',
  },
};

export function highlightCode(code: string): ReactNode[] {
  const tokens = tokenize(code);
  return tokens.map((token, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are static, derived from code string
    <span key={index} style={TOKEN_STYLES[token.type]}>
      {token.text}
    </span>
  ));
}
