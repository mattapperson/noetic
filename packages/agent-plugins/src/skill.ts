/**
 * Agent Plugins §7.1 — skill discovery — plus the `SKILL.md` format itself,
 * which §7.1 delegates to the Agent Skills specification
 * (https://agentskills.io/specification).
 *
 * §7.1 is deliberately shallow: only the *immediate* children of `skills/`
 * are candidates, and a client "MUST NOT recursively search deeper
 * descendants". A nested `skills/a/b/SKILL.md` is not a skill, and treating it
 * as one would let a plugin smuggle in skills the author never declared.
 *
 * The frontmatter field set is closed by the Agent Skills spec, but unlike the
 * plugin manifest there is no report-and-ignore carve-out: a `SKILL.md` that
 * does not conform is skipped whole, and its siblings still load.
 */

import YAML from 'yaml';
import { z } from 'zod';

//#region Frontmatter

/** Agent Skills `name`: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/double hyphen. */
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * @public The `SKILL.md` YAML frontmatter, per the Agent Skills specification.
 *
 * Strict: the spec enumerates the field set, and an unrecognized key is far
 * more likely to be a typo (`descripton`) than a deliberate extension — the
 * spec provides `metadata` for that. A typo that silently loaded would leave
 * the author with a skill the model never selects.
 */
export const SkillFrontmatterSchema = z.strictObject({
  name: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
});

/** @public */
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

//#endregion

//#region Parsing

/** @public A parsed, validated `SKILL.md`. */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** The Markdown body after the frontmatter block — the skill's instructions. */
  body: string;
}

/** @public Outcome of parsing a `SKILL.md` document. */
export type SkillParseResult =
  | {
      ok: true;
      skill: ParsedSkill;
    }
  | {
      ok: false;
      detail: string;
    };

/**
 * Split a `SKILL.md` into its raw frontmatter block and its body.
 *
 * The delimiter is a `---` line at the very start of the file and the next
 * `---` line on its own. Anchoring the opening delimiter to position zero is
 * what stops a `---` horizontal rule in the middle of a body from being read
 * as frontmatter.
 */
function splitFrontmatter(source: string): {
  yaml: string;
  body: string;
} | null {
  // Tolerate a UTF-8 BOM and CRLF line endings — both are common in files
  // authored on Windows, and neither says anything about conformance.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return null;
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return null;
  }
  // The closing delimiter must be a line of its own: `---` followed by a
  // newline or by end-of-file.
  const after = text.slice(end + 4);
  if (after !== '' && !after.startsWith('\n')) {
    return null;
  }
  return {
    yaml: text.slice(4, end),
    body: after.startsWith('\n') ? after.slice(1) : after,
  };
}

/**
 * Parse and validate a `SKILL.md` document.
 *
 * @public
 * @param source - Raw file contents.
 * @param directoryName - The skill directory's name. The Agent Skills spec
 *   requires `name` to match it, which is what keeps the discovered skill id
 *   (a directory name) and the declared id from drifting apart.
 */
export function parseSkill(source: string, directoryName: string): SkillParseResult {
  const split = splitFrontmatter(source);
  if (split === null) {
    return {
      ok: false,
      detail: 'SKILL.md must begin with a YAML frontmatter block delimited by `---` lines',
    };
  }

  let raw: unknown;
  try {
    raw = YAML.parse(split.yaml);
  } catch (error) {
    return {
      ok: false,
      detail: `SKILL.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || '<root>';
    return {
      ok: false,
      detail: `SKILL.md frontmatter field '${field}': ${issue?.message ?? 'invalid'}`,
    };
  }

  if (parsed.data.name !== directoryName) {
    return {
      ok: false,
      detail: `SKILL.md 'name' is '${parsed.data.name}' but the skill directory is '${directoryName}'; the Agent Skills specification requires them to match`,
    };
  }

  return {
    ok: true,
    skill: {
      frontmatter: parsed.data,
      body: split.body,
    },
  };
}

//#endregion

//#region Allowed tools

/**
 * Split the experimental `allowed-tools` field into its individual entries.
 *
 * The field is a space-separated string, so an entry that itself contains a
 * space cannot be expressed — splitting on whitespace is the whole contract.
 *
 * @public
 */
export function parseAllowedTools(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

//#endregion
