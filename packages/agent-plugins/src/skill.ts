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
 * The frontmatter field set is *open* — the Agent Skills spec enumerates the
 * fields it defines but never forbids others, so an unrecognized key is a
 * warning and the skill still loads. A `SKILL.md` that violates a rule the spec
 * does state (a malformed `name`, a missing `description`) is skipped whole,
 * and its siblings still load.
 */

import YAML from 'yaml';
import { z } from 'zod';

//#region Frontmatter

/** Agent Skills `name`: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/double hyphen. */
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * @public The `SKILL.md` YAML frontmatter, per the Agent Skills specification.
 *
 * **Open, not closed.** The specification enumerates the fields above but never
 * says the set is closed — there is no MUST NOT about additional keys, and it
 * says the opposite about the directory ("may contain any files and directories
 * beyond the required SKILL.md"). Enumerating defined fields is not the same as
 * forbidding others.
 *
 * This was `z.strictObject` and it was wrong. Agent Plugins §7.1 only obliges a
 * client to skip a skill that does not conform; strict mode manufactured the
 * non-conformance, and real skills paid for it — anything carrying `model:`,
 * `argument-hint:`, or `disable-model-invocation:` (all common in the wild,
 * including a skill in this very repository) silently never loaded.
 *
 * Unrecognized keys are still worth surfacing, because a typo like `descripton`
 * really does leave a skill the model can never select. So they are reported as
 * warnings and the skill loads anyway — a diagnostic, not a rejection.
 */
export const SkillFrontmatterSchema = z.looseObject({
  name: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  /**
   * The spec calls this "a map from string keys to string values", but YAML
   * turns an unquoted `version: 1.0` into a number. Coercing scalars is far
   * kinder than discarding the whole skill over a missing pair of quotes.
   */
  metadata: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
      ]),
    )
    .transform((entries) =>
      Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    )
    .optional(),
  'allowed-tools': z.string().optional(),
});

/**
 * The fields the Agent Skills specification defines. Not a closed set — an
 * unrecognized key is a warning, not a rejection.
 *
 * Derived from the schema rather than restated, so adding a field above cannot
 * leave this list behind. A stale copy would warn about a field the client
 * *does* support, which is the same false alarm the open schema exists to stop.
 */
const DEFINED_FIELDS = new Set(Object.keys(SkillFrontmatterSchema.shape));

/** @public */
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

//#endregion

//#region Parsing

/** @public A parsed, validated `SKILL.md`. */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** The Markdown body after the frontmatter block — the skill's instructions. */
  body: string;
  /**
   * Non-fatal problems worth reporting: frontmatter keys the Agent Skills
   * specification does not define. The skill loaded regardless — these exist so
   * a typo like `descripton` is visible rather than silently costing the author
   * a skill the model can never select.
   */
  warnings: string[];
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

  const warnings: string[] = [];
  if (typeof raw === 'object' && raw !== null) {
    for (const key of Object.keys(raw)) {
      if (!DEFINED_FIELDS.has(key)) {
        warnings.push(
          `frontmatter key '${key}' is not defined by the Agent Skills specification; it is preserved on the parsed frontmatter but this client gives it no meaning`,
        );
      }
    }
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
      warnings,
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
