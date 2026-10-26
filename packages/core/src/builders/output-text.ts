/**
 * Writes a value the way every JSON workflow node writes its output (spec 26 § `compute`):
 * a string as is, `null` or `undefined` as the empty string, anything else as JSON.
 */
export function outputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}
