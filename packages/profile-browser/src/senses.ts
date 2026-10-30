/**
 * The `x-artifact` sense `browser@1` documents: files the browser downloaded.
 * Summary `download "filename"`; matcher `download`, optionally with a quoted
 * filename in which `*` matches any run of characters.
 */

import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from '@noetic-tools/profile-ui';
import { malformed, parsed, quote, tokenize } from '@noetic-tools/profile-ui';
import type { SenseDescriptor } from '@noetic-tools/types';

//#region Helpers

const SPECIAL_RE = /[.+?^${}()|[\]\\]/g;

function filenamePattern(glob: string): RegExp {
  const source = glob
    .split('*')
    .map((part) => part.replace(SPECIAL_RE, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function readDownload(text: string):
  | {
      readonly filename?: string;
    }
  | string {
  const read = tokenize(text);
  if (!read.ok) {
    return read.reason;
  }
  const [word, filename, extra] = read.tokens;
  if (!word || word.kind !== 'word' || word.value !== 'download') {
    return "An x-artifact matcher starts with 'download'.";
  }
  if (extra || (filename && filename.kind !== 'quoted')) {
    return 'An x-artifact matcher is download and at most one quoted filename.';
  }
  return {
    filename: filename?.value,
  };
}

//#endregion

//#region Public API

/** @public The `x-artifact` sense's descriptor: the browser, not the app, reports a download. */
export const ARTIFACT_SENSE_DESCRIPTOR: SenseDescriptor = {
  independence: 'independent',
  grade: 'consequence',
  note: 'A file the browser downloaded, carried as a blob.',
};

/** @public Writes an `x-artifact` summary: `download "filename"`. */
export function formatArtifactSummary(filename: string): string {
  return `download ${quote(filename)}`;
}

/** @public Parses an `x-artifact` matcher. */
export function parseArtifactMatcher(text: string): SenseMatcherParse {
  const download = readDownload(text);
  if (typeof download === 'string') {
    return malformed(download);
  }
  const wanted = download.filename;
  const pattern = wanted === undefined ? undefined : filenamePattern(wanted);
  const exact = wanted !== undefined && !wanted.includes('*');
  const matcher: SenseMatcher = {
    sense: 'x-artifact',
    source: text,
    summary: exact ? formatArtifactSummary(wanted) : undefined,
    matches(observation): boolean {
      const seen = readDownload(observation.summary);
      if (typeof seen === 'string' || seen.filename === undefined) {
        return false;
      }
      return pattern === undefined || pattern.test(seen.filename);
    },
  };
  return parsed(matcher);
}

/** @public The `x-artifact` sense grammar. */
export const artifactSense: SenseGrammar<'x-artifact'> = {
  sense: 'x-artifact',
  summaryFormat: 'download "filename"',
  parse: parseArtifactMatcher,
};

/** @public The `x-` sense grammars `browser@1` documents, for `parseSenseMatcher`'s `extra`. */
export const browserSenseGrammars: Readonly<Record<string, SenseGrammar>> = {
  'x-artifact': artifactSense,
};

//#endregion
