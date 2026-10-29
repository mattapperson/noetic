/**
 * The `ui` sense: what is on screen. Summary `role "name"` (`button "Pay"`);
 * matcher a locator — a role, optionally with a quoted accessible name
 * (`button "Pay"`, `heading`).
 */

import { quote, tokenize } from './lexer';
import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';
import { malformed, parsed } from './types';

//#region Types

/** @public An element as a `ui` summary or locator names it. */
export interface UiSummaryParts {
  readonly role: string;
  readonly name?: string;
}

//#endregion

//#region Helpers

const ROLE_RE = /^[a-z][a-z0-9-]*$/;

function sameElement(locator: UiSummaryParts, element: UiSummaryParts): boolean {
  if (locator.role !== element.role) {
    return false;
  }
  return locator.name === undefined || locator.name === (element.name ?? '');
}

//#endregion

//#region Public API

/** @public Writes a `ui` summary: `role "name"`, or the bare role when the element has no name. */
export function formatUiSummary(parts: UiSummaryParts): string {
  if (parts.name === undefined || parts.name === '') {
    return parts.role;
  }
  return `${parts.role} ${quote(parts.name)}`;
}

/**
 * @public
 * Reads a locator or a `ui` summary: a lowercase role, optionally followed by
 * a quoted name. Returns the parts, or why the text is malformed.
 */
export function parseLocator(text: string): UiSummaryParts | string {
  const read = tokenize(text);
  if (!read.ok) {
    return read.reason;
  }
  const [role, name, extra] = read.tokens;
  if (!role) {
    return 'A locator needs a role, e.g. button "Pay".';
  }
  if (role.kind !== 'word' || !ROLE_RE.test(role.value)) {
    return `'${role.value}' is not a role; a locator starts with a lowercase role.`;
  }
  if (extra) {
    return 'A locator is a role and at most one quoted name.';
  }
  if (!name) {
    return {
      role: role.value,
    };
  }
  if (name.kind !== 'quoted') {
    return `The name '${name.value}' must be quoted: ${role.value} ${quote(name.value)}.`;
  }
  return {
    role: role.value,
    name: name.value,
  };
}

/** @public Parses a `ui` matcher. */
export function parseUiMatcher(text: string): SenseMatcherParse {
  const locator = parseLocator(text);
  if (typeof locator === 'string') {
    return malformed(locator);
  }
  const matcher: SenseMatcher = {
    sense: 'ui',
    source: text,
    summary: locator.name === undefined ? undefined : formatUiSummary(locator),
    matches(observation): boolean {
      const element = parseLocator(observation.summary);
      return typeof element !== 'string' && sameElement(locator, element);
    },
  };
  return parsed(matcher);
}

/** @public The `ui` sense grammar. */
export const uiSense: SenseGrammar<'ui'> = {
  sense: 'ui',
  summaryFormat: 'role "name"',
  parse: parseUiMatcher,
};

//#endregion
