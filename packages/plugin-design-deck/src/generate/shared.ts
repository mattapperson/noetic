/**
 * Parse JSON out of an LLM response that may or may not be wrapped in a
 * ```json fence. Returns `null` if no valid JSON can be extracted.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last-chance: sometimes the model emits text before/after JSON. Try the
    // first { or [ through the matching last } or ].
    const start = indexOfFirst(candidate, '{', '[');
    const end = indexOfLast(candidate, '}', ']');
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function indexOfFirst(source: string, ...chars: string[]): number {
  let best = -1;
  for (const c of chars) {
    const i = source.indexOf(c);
    if (i >= 0 && (best < 0 || i < best)) {
      best = i;
    }
  }
  return best;
}

function indexOfLast(source: string, ...chars: string[]): number {
  let best = -1;
  for (const c of chars) {
    const i = source.lastIndexOf(c);
    if (i > best) {
      best = i;
    }
  }
  return best;
}
