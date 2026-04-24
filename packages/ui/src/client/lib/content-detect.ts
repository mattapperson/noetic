/**
 * Detect whether a string is JSON, Markdown, or plain text.
 */

type ContentType = 'json' | 'markdown' | 'text';

/** Markdown indicators — if two or more match, classify as markdown. */
const MD_PATTERNS = [
  /^#{1,6}\s/m, // headings
  /\*\*.+?\*\*/, // bold
  /(?<!\*)\*(?!\*).+?(?<!\*)\*(?!\*)/, // italic
  /^[-*]\s/m, // unordered list
  /^\d+\.\s/m, // ordered list
  /```/, // code fence
  /`.+?`/, // inline code
  /\[.+?\]\(.+?\)/, // links
  /^>\s/m, // blockquote
  /\\\(.+?\\\)/, // LaTeX inline math \( ... \)
  /\\\[[\s\S]+?\\\]/, // LaTeX display math \[ ... \]
  /\$\$.+?\$\$/, // display math $$ ... $$
  /(?<!\$)\$(?!\$).+?(?<!\$)\$(?!\$)/, // inline math $ ... $
] as const;

const MD_THRESHOLD = 2;

export function detectContentType(value: string): ContentType {
  const trimmed = value.trim();

  // JSON: starts with { or [
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // not valid JSON, fall through
    }
  }

  // Markdown: count pattern matches
  let hits = 0;
  for (const pattern of MD_PATTERNS) {
    if (pattern.test(value)) {
      hits++;
      if (hits >= MD_THRESHOLD) {
        return 'markdown';
      }
    }
  }

  return 'text';
}
