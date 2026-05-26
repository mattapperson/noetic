/**
 * Parse a tool's structured output through a zod schema. The output may arrive
 * as a JSON string (streamed) or a pre-parsed object; both paths are handled.
 */

import type { z } from 'zod';

export function parseToolOutput<T extends z.ZodTypeAny>(
  schema: T,
  output: unknown,
): z.infer<T> | null {
  if (typeof output === 'string') {
    try {
      const parsed = schema.safeParse(JSON.parse(output));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(output);
  return parsed.success ? parsed.data : null;
}
