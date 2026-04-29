//#region Types

/** @public Validator failure summary that, when present, switches triage into Fix-task mode. */
export interface ValidatorFailureSummary {
  validatorRunId: string;
  failedAssertions: ReadonlyArray<{
    assertionId: string;
    statement: string;
    message: string;
    expected?: string;
    actual?: string;
  }>;
  summary: string;
  blockedReason?: string;
}

/** @public Argument bag for {@link buildTriageUserPrompt}. */
export interface TriageUserPromptArgs {
  feature: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: ReadonlyArray<string>;
  };
  parentSliceVerification?: string;
  validatorFailure?: ValidatorFailureSummary;
}

/** @public Argument bag for {@link buildValidationSystemPrompt}. */
export interface ValidationSystemPromptArgs {
  feature: {
    title: string;
    description: string;
    acceptanceCriteria: ReadonlyArray<string>;
  };
  assertions: ReadonlyArray<{
    id: string;
    statement: string;
  }>;
  taskContextBlob: string;
}

//#endregion

//#region Interview prompt

export const INTERVIEW_SYSTEM_PROMPT = `You are a mission planning assistant for a project management system.

Your job: help users transform high-level goals into structured mission plans with milestones, slices, and features — each with verification criteria.

## Mission Hierarchy
- Mission: The top-level objective (the user will provide this)
- Milestone: A major phase or deliverable within the mission. Each milestone has verification criteria that define how to confirm the phase is complete.
- Slice: A focused work unit within a milestone that can be activated and worked on independently. Each slice has verification criteria.
- Feature: A specific deliverable within a slice, detailed enough to become a task. Each feature has acceptance criteria.

## Conversation Flow
1. The user describes their mission goal
2. Ask clarifying questions to understand scope, constraints, technical context, user needs, and priorities
3. Push back on vague objectives — ask for specifics
4. Challenge unrealistic scope — suggest phasing
5. Once you have enough information (typically 4-8 questions), produce the structured plan

## Question Types
- "single_select" (DEFAULT): 3–6 options. ALWAYS include "Other (please describe)" as the LAST option.
- "multi_select": when multiple options can apply. 4–6 options + "Other".
- "confirm": yes/no decisions.
- "text": ONLY for names, URLs, or unique free-form values.

## Response Format
Always respond with valid JSON. For a question:
{"type": "question", "data": {"id": "q-...", "type": "single_select|multi_select|confirm|text", "question": "...", "description": "...", "options": [{"id": "...", "label": "...", "description": "..."}]}}

For completion:
{"type": "complete", "data": {"missionTitle": "...", "missionDescription": "...", "milestones": [{"title": "...", "description": "...", "verification": "...", "slices": [{"title": "...", "description": "...", "verification": "...", "features": [{"title": "...", "description": "...", "acceptanceCriteria": "..."}]}]}]}}

Aim for 2-4 milestones, 1-3 slices per milestone, 2-5 features per slice.`;

//#endregion

//#region Triage prompt

export const TRIAGE_SYSTEM_PROMPT = `You are a task specification agent for "noetic missions". Your job: take a feature spec and produce a fully specified PROMPT.md that an autonomous coding agent can execute end-to-end without further human guidance.

The PROMPT.md you write will be persisted at <cwd>/.noetic/PROMPT.md and read by the executor. It must be concrete, self-contained, and verifiable.

## Required structure for PROMPT.md

The output must contain these sections, in this order, as Markdown:

### Mission
One paragraph stating the user-facing goal of this feature. Echo the feature title and the slice's verification criteria so the executor knows what "done" looks like.

### Dependencies
List external libraries, services, or peer features this work depends on. If none, write "None."

### Context to Read First
Bullet list of files and symbols the executor MUST read before writing any code. Be specific (path + symbol). This section is non-negotiable — never leave it empty.

### File Scope
Two sub-lists:
- **Files to modify**: explicit paths with one-line reason per file.
- **Files to create**: explicit paths with one-line description per file.

If you are unsure of the exact files, write "Inspect the repo before deciding" and require the executor to read first.

### Steps

Numbered steps from 0 onward.

- **Step 0 — Preflight**: read the files in "Context to Read First", confirm the working tree is clean, and identify the project's test command. If the repo's testing posture is unclear, the executor must run a small dry-run before continuing.
- **Step 1..N**: implementation steps. Each step is a unit of work small enough to verify in isolation. Each step must end with a verification (test, type check, manual smoke).
- **Final Step — Testing & Verification**: run the project's full test suite plus any feature-specific tests added. **ZERO test failures allowed.** If a test fails, the step is not done. Also run the type checker and the linter. Re-run after fixes until clean.

### Review Level

Score the task across four axes (each 0–2; total 0–8):
- **Blast radius** (0 = single file, 1 = single module, 2 = cross-package or runtime-critical)
- **Pattern novelty** (0 = follows existing pattern, 1 = adapts existing pattern, 2 = introduces new pattern)
- **Security** (0 = no auth/data path, 1 = touches auth or data validation, 2 = touches secrets, crypto, or external IO with attacker-controlled inputs)
- **Reversibility** (0 = trivially revertable, 1 = revert needs care, 2 = irreversible / data migration)

Map total to a level:
- 0–1 → Level 0 (auto-merge candidate)
- 2–3 → Level 1 (one-reviewer)
- 4–5 → Level 2 (two-reviewer + targeted test additions)
- 6–8 → Level 3 (architectural review + full regression suite)

State the per-axis scores AND the final level explicitly in the PROMPT.md so the executor and downstream reviewers see the same number.

## Quality bar

- Write as if the executor has zero prior context for this feature.
- Be ruthless about removing ambiguity. If a sentence has two plausible interpretations, rewrite it.
- Prefer "Read X first" over "you might want to consider X".
- Do NOT include speculative future work; only what this feature requires.
- Do NOT invent files, symbols, or APIs you have not verified by reading the repo.

## Fix-task mode

If the input includes a "Why the previous attempt failed" section, you are writing a Fix task, not a fresh implementation. Frame the PROMPT.md as:

### Why the previous attempt failed
Echo the validator's failure summary verbatim and list each failed assertion. The executor must address every one.

Then continue with the standard sections, but scope Steps to fixes for the listed failures only — do NOT re-do work that already passed.

## Output

Respond with a JSON object exactly matching the requested schema. Put the entire PROMPT.md text in the \`promptMd\` field. Put the level integer (0, 1, 2, or 3) in \`reviewLevel\`. Do not wrap the JSON in code fences.`;

//#endregion

//#region Triage user-prompt builder

/** @public Build the per-feature user prompt that pairs with {@link TRIAGE_SYSTEM_PROMPT}. */
export function buildTriageUserPrompt(args: TriageUserPromptArgs): string {
  const sections: string[] = [];
  sections.push('# Feature to triage', '');
  sections.push(`- id: ${args.feature.id}`);
  sections.push(`- title: ${args.feature.title}`);
  sections.push('');
  sections.push('## Description', '', args.feature.description.trim() || '(none provided)');
  sections.push('');
  sections.push('## Acceptance criteria');
  sections.push('');
  if (args.feature.acceptanceCriteria.length === 0) {
    sections.push('(none provided — ask for clarification or infer from description)');
  } else {
    for (const criterion of args.feature.acceptanceCriteria) {
      sections.push(`- ${criterion}`);
    }
  }
  sections.push('');
  if (args.parentSliceVerification && args.parentSliceVerification.length > 0) {
    sections.push('## Parent slice verification', '', args.parentSliceVerification.trim(), '');
  }
  if (args.validatorFailure) {
    sections.push('## Why the previous attempt failed', '');
    sections.push(args.validatorFailure.summary.trim() || '(no summary)');
    sections.push('');
    sections.push('### Failed assertions');
    sections.push('');
    for (const failure of args.validatorFailure.failedAssertions) {
      sections.push(`- **${failure.assertionId}** — ${failure.statement}`);
      sections.push(`  - message: ${failure.message}`);
      if (failure.expected !== undefined) {
        sections.push(`  - expected: ${failure.expected}`);
      }
      if (failure.actual !== undefined) {
        sections.push(`  - actual: ${failure.actual}`);
      }
    }
    if (args.validatorFailure.blockedReason) {
      sections.push('');
      sections.push(`### Blocked reason\n\n${args.validatorFailure.blockedReason.trim()}`);
    }
    sections.push('');
  }
  sections.push(
    '## Output',
    '',
    'Produce a JSON object with `promptMd` (the full PROMPT.md text) and `reviewLevel` (0, 1, 2, or 3).',
  );
  return sections.join('\n');
}

//#endregion

//#region Validation prompt

/**
 * @public
 * Build the system prompt for the validator's read-only LLM. The validator must
 * emit a JSON object: `{status: 'pass'|'fail'|'blocked', assertions: [...], summary, blockedReason?}`.
 */
export function buildValidationSystemPrompt(args: ValidationSystemPromptArgs): string {
  const { feature, assertions, taskContextBlob } = args;
  const sections: string[] = [];
  sections.push(
    'You are a strict, read-only validator for the noetic missions framework.',
    "Given a feature, its assertion list, and the executor's task context (diff + PROMPT.md + final agent message), determine whether the implementation satisfies every assertion.",
    '',
  );
  sections.push('## Feature');
  sections.push('');
  sections.push(`- title: ${feature.title}`);
  sections.push('- description:');
  sections.push('');
  sections.push(feature.description.trim() || '(none provided)');
  sections.push('');
  sections.push('### Acceptance criteria');
  sections.push('');
  if (feature.acceptanceCriteria.length === 0) {
    sections.push('(none provided)');
  } else {
    for (const criterion of feature.acceptanceCriteria) {
      sections.push(`- ${criterion}`);
    }
  }
  sections.push('');
  sections.push('## Assertions to evaluate');
  sections.push('');
  if (assertions.length === 0) {
    sections.push('(no formal assertions — fall back to acceptance criteria)');
  } else {
    for (const assertion of assertions) {
      sections.push(`- **${assertion.id}** — ${assertion.statement}`);
    }
  }
  sections.push('');
  sections.push('## Task context');
  sections.push('');
  sections.push('```');
  sections.push(taskContextBlob.trim());
  sections.push('```');
  sections.push('');
  sections.push('## Rules');
  sections.push('');
  sections.push(
    '- You may use ONLY read-only tools to inspect the working tree (Read, Grep, Find, Ls).',
  );
  sections.push('- DO NOT modify any file. DO NOT run mutating commands.');
  sections.push(
    '- Mark an assertion `passed: true` only when the code change demonstrably satisfies it. Otherwise `passed: false`.',
  );
  sections.push(
    '- If the task context is missing required information (e.g. no diff), set `status: "blocked"` and explain in `blockedReason`.',
  );
  sections.push(
    '- The final iteration MUST emit a single JSON object (no Markdown fences) matching this schema:',
  );
  sections.push('');
  sections.push('```json');
  sections.push(
    JSON.stringify(
      {
        status: '"pass" | "fail" | "blocked"',
        assertions: [
          {
            assertionId: 'string',
            passed: true,
            message: 'string',
            expected: 'string (optional)',
            actual: 'string (optional)',
          },
        ],
        summary: 'string',
        blockedReason: 'string (optional, only when status is "blocked")',
      },
      null,
      2,
    ),
  );
  sections.push('```');
  sections.push('');
  sections.push('`status` MUST be `"pass"` only when every assertion has `passed: true`.');
  return sections.join('\n');
}

//#endregion
