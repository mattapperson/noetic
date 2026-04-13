//#region Types

/**
 * Props compatible with Ink's `<Text>` component.
 */
export interface InkTextProps {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/**
 * Input options for text styling. Uses Gridland-style naming (fg/bg/dim)
 * which gets mapped to Ink naming (color/backgroundColor/dimColor).
 */
export interface TextStyleOptions {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

//#endregion

//#region Ink-Compatible Helper

/**
 * Converts friendly boolean flags into props compatible with Ink's `<Text>` component.
 *
 * Maps Gridland-style naming to Ink naming:
 * - `fg` -> `color`
 * - `bg` -> `backgroundColor`
 * - `dim` -> `dimColor`
 *
 * @example
 * ```tsx
 * <Text {...textStyleProps({ fg: 'green', bold: true })}>Hello</Text>
 * ```
 */
export function textStyleProps(opts: TextStyleOptions): InkTextProps {
  const result: InkTextProps = {};

  if (opts.fg) {
    result.color = opts.fg;
  }
  if (opts.bg) {
    result.backgroundColor = opts.bg;
  }
  if (opts.bold) {
    result.bold = true;
  }
  if (opts.dim) {
    result.dimColor = true;
  }
  if (opts.italic) {
    result.italic = true;
  }
  if (opts.underline) {
    result.underline = true;
  }
  if (opts.inverse) {
    result.inverse = true;
  }

  return result;
}

//#endregion

//#region Deprecated Gridland Helper

const BOLD = 1 << 0; // 1
const DIM = 1 << 1; // 2
const ITALIC = 1 << 2; // 4
const UNDERLINE = 1 << 3; // 8
// bit 4 (1 << 4) = BLINK — intentionally omitted, not rendered by canvas painter
const INVERSE = 1 << 5; // 32

/**
 * Converts friendly boolean flags into a style object that works with
 * opentui's `<span>` and `<text>` elements.
 *
 * The `style` prop copies values directly to the renderable instance.
 * Colors (`fg`, `bg`) are instance properties so they work directly,
 * but text decorations (bold, dim, inverse, etc.) must be packed into
 * the numeric `attributes` bitmask.
 *
 * @deprecated Use `textStyleProps()` for Ink compatibility. This function
 * will be removed once all components are migrated to Ink.
 */
export function textStyle(opts: TextStyleOptions): {
  fg?: string;
  bg?: string;
  attributes?: number;
} {
  let attributes = 0;
  if (opts.bold) {
    attributes |= BOLD;
  }
  if (opts.dim) {
    attributes |= DIM;
  }
  if (opts.italic) {
    attributes |= ITALIC;
  }
  if (opts.underline) {
    attributes |= UNDERLINE;
  }
  if (opts.inverse) {
    attributes |= INVERSE;
  }

  const result: {
    fg?: string;
    bg?: string;
    attributes?: number;
  } = {};
  if (opts.fg) {
    result.fg = opts.fg;
  }
  if (opts.bg) {
    result.bg = opts.bg;
  }
  if (attributes) {
    result.attributes = attributes;
  }
  return result;
}

//#endregion
