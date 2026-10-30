/**
 * A small semver matcher for profile and extension negotiation (spec 35 §
 * Negotiation, spec 36 § Versioning). Supports exact and partial versions,
 * `*`/`x` wildcards, `^`, `~`, the comparators `>`, `>=`, `<`, `<=`, `=`,
 * space-separated AND and `||`. A prerelease sorts before its release.
 */

//#region Types

/** @public A parsed semantic version. */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

type Comparator = (v: SemVer) => boolean;

interface PartialVersion {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: string;
}

//#endregion

//#region Parsing

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL_RE =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @public
 * Parses `1.2.3` (optionally `-pre` / `+build`).
 * @returns The version, or `undefined` when `text` is not a full semver.
 */
export function parseSemVer(text: string): SemVer | undefined {
  const m = VERSION_RE.exec(text.trim());
  if (!m) {
    return undefined;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

function wildcardOrNumber(part: string | undefined): number | undefined {
  if (part === undefined || part === 'x' || part === 'X' || part === '*') {
    return undefined;
  }
  return Number(part);
}

function parsePartial(text: string): PartialVersion | undefined {
  const m = PARTIAL_RE.exec(text);
  if (!m) {
    return undefined;
  }
  return {
    major: wildcardOrNumber(m[1]),
    minor: wildcardOrNumber(m[2]),
    patch: wildcardOrNumber(m[3]),
    prerelease: m[4] ?? '',
  };
}

//#endregion

//#region Comparison

/** @public Compares two versions: negative, zero or positive. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (a.prerelease === '') {
    return 1;
  }
  if (b.prerelease === '') {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

function floor(p: PartialVersion): SemVer {
  return {
    major: p.major ?? 0,
    minor: p.minor ?? 0,
    patch: p.patch ?? 0,
    prerelease: p.prerelease,
  };
}

function version(major: number, minor: number, patch: number): SemVer {
  return {
    major,
    minor,
    patch,
    prerelease: '',
  };
}

function atLeast(min: SemVer): Comparator {
  return (v) => compareSemVer(v, min) >= 0;
}

function below(max: SemVer): Comparator {
  // `0-0` sorts before every prerelease of that version, so `<2.0.0` excludes `2.0.0-rc`.
  const bound = {
    ...max,
    prerelease: max.prerelease === '' ? '0' : max.prerelease,
  };
  return (v) => compareSemVer(v, bound) < 0;
}

function caret(p: PartialVersion): Comparator[] {
  const lo = floor(p);
  if (p.major === undefined) {
    return [];
  }
  if (p.major > 0 || p.minor === undefined) {
    return [
      atLeast(lo),
      below(version(p.major + 1, 0, 0)),
    ];
  }
  if (p.minor > 0 || p.patch === undefined) {
    return [
      atLeast(lo),
      below(version(0, p.minor + 1, 0)),
    ];
  }
  return [
    atLeast(lo),
    below(version(0, 0, p.patch + 1)),
  ];
}

function tilde(p: PartialVersion): Comparator[] {
  const lo = floor(p);
  if (p.major === undefined) {
    return [];
  }
  if (p.minor === undefined) {
    return [
      atLeast(lo),
      below(version(p.major + 1, 0, 0)),
    ];
  }
  return [
    atLeast(lo),
    below(version(p.major, p.minor + 1, 0)),
  ];
}

function exact(p: PartialVersion): Comparator[] {
  if (p.major === undefined) {
    return [];
  }
  if (p.minor === undefined) {
    return [
      atLeast(version(p.major, 0, 0)),
      below(version(p.major + 1, 0, 0)),
    ];
  }
  if (p.patch === undefined) {
    return [
      atLeast(version(p.major, p.minor, 0)),
      below(version(p.major, p.minor + 1, 0)),
    ];
  }
  const target = floor(p);
  return [
    (v) => compareSemVer(v, target) === 0,
  ];
}

const OPERATORS: Record<string, (p: PartialVersion) => Comparator[]> = {
  '^': caret,
  '~': tilde,
  '': exact,
  '=': exact,
  '>=': (p) => [
    atLeast(floor(p)),
  ],
  '>': (p) => [
    (v) => compareSemVer(v, floor(p)) > 0,
  ],
  '<': (p) => [
    below(floor(p)),
  ],
  '<=': (p) => [
    (v) => compareSemVer(v, floor(p)) <= 0,
  ],
};

const TERM_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

function parseTerm(term: string): Comparator[] | undefined {
  const m = TERM_RE.exec(term);
  if (!m) {
    return undefined;
  }
  const op = OPERATORS[m[1] ?? ''];
  const partial = parsePartial(m[2] ?? '');
  if (!op || !partial) {
    return undefined;
  }
  return op(partial);
}

function parseAlternative(alternative: string): Comparator[] | undefined {
  const terms = alternative
    .trim()
    .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) {
    return [];
  }
  const comparators: Comparator[] = [];
  for (const term of terms) {
    const parsed = parseTerm(term);
    if (!parsed) {
      return undefined;
    }
    comparators.push(...parsed);
  }
  return comparators;
}

//#endregion

//#region Public API

/** @public Whether `range` is a range this matcher understands. */
export function isValidRange(range: string): boolean {
  return range.split('||').every((alt) => parseAlternative(alt) !== undefined);
}

/**
 * @public
 * Whether `version` satisfies `range`.
 * @returns `false` when either cannot be parsed.
 */
export function satisfiesRange(versionText: string, range: string): boolean {
  const v = parseSemVer(versionText);
  if (!v) {
    return false;
  }
  for (const alternative of range.split('||')) {
    const comparators = parseAlternative(alternative);
    if (comparators?.every((c) => c(v))) {
      return true;
    }
  }
  return false;
}

//#endregion
