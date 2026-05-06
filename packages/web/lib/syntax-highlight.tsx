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

function readWhile(code: string, start: number, test: (char: string) => boolean): [string, number] {
  let i = start;
  let text = '';
  while (i < code.length && test(code[i])) {
    text += code[i];
    i++;
  }
  return [text, i];
}

function readLineComment(code: string, start: number): [Token, number] {
  const [text, index] = readWhile(code, start, (char) => char !== '\n');
  return [
    {
      text,
      type: 'comment',
    },
    index,
  ];
}

function readString(code: string, start: number): [Token, number] {
  const quote = code[start];
  let i = start + 1;
  let text = quote;
  while (i < code.length && code[i] !== quote) {
    if (code[i] === '\\') {
      text += code.slice(i, i + 2);
      i += 2;
      continue;
    }
    text += code[i];
    i++;
  }
  if (i < code.length) {
    text += code[i];
    i++;
  }
  return [
    {
      text,
      type: 'string',
    },
    i,
  ];
}

function tokenForWord(word: string): Token {
  if (KEYWORDS.has(word)) {
    return {
      text: word,
      type: 'keyword',
    };
  }
  if (TYPES.has(word) || /^[A-Z]/.test(word)) {
    return {
      text: word,
      type: 'type',
    };
  }
  return {
    text: word,
    type: 'default',
  };
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    const char = code[i];
    let token: Token;
    if (char === '/' && code[i + 1] === '/') {
      [token, i] = readLineComment(code, i);
    } else if (char === '"' || char === "'" || char === '`') {
      [token, i] = readString(code, i);
    } else if (/\s/.test(char)) {
      const [text, next] = readWhile(code, i, (c) => /\s/.test(c));
      token = { text, type: 'default' };
      i = next;
    } else if (/[a-zA-Z_$]/.test(char)) {
      const [word, next] = readWhile(code, i, (c) => /[a-zA-Z0-9_$]/.test(c));
      token = tokenForWord(word);
      i = next;
    } else if (/[=+\-*/<>!&|:;.,?()[\]{}]/.test(char)) {
      token = { text: char, type: 'operator' };
      i++;
    } else if (/\d/.test(char)) {
      const [text, next] = readWhile(code, i, (c) => /[\d.]/.test(c));
      token = { text, type: 'default' };
      i = next;
    } else {
      token = { text: char, type: 'default' };
      i++;
    }
    tokens.push(token);
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
