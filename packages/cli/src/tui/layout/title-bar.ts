/**
 * Helpers for the Context Split View pane chrome.
 *
 * Each pane in wide/narrow layouts is delimited by a single top horizontal
 * rule with an inline title (e.g. `─── ► Context ─────────`) rather than a
 * full bordered box. Focus is signalled by a `►` glyph + bold title; the
 * rule itself stays the same character across both states so the chrome
 * doesn't visibly redraw on focus swap.
 *
 * See specs/28-context-split-view.md.
 */

const HORIZONTAL = '─'; // ─

/**
 * Build the title-bar text for a pane.
 *
 * Returns a single string of `─ ► Title ────────…` whose total length is
 * exactly `width` (ink renders this as one line). `focused=true` swaps the
 * leading two spaces for a `► ` glyph; the caller still applies bold/dim
 * to convey focus through text style alongside the glyph.
 */
export function buildTitleBar(width: number, focused: boolean, title: string): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const glyph = focused ? '► ' : '  '; // ►
  // ─ <glyph><title> <dashes…>
  const lead = `${HORIZONTAL} ${glyph}${title} `;
  if (safeWidth <= lead.length) {
    return lead.slice(0, safeWidth);
  }
  return lead + HORIZONTAL.repeat(safeWidth - lead.length);
}
