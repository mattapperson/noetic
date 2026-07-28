#!/usr/bin/env bun
/**
 * Applies the "Standard OSS" branch-protection ruleset to `main`.
 *
 * This is a one-time (idempotent) maintainer operation. It is NOT run by CI and
 * changes live GitHub repository settings, so it defaults to a dry run: it prints
 * the payload and the status-check names currently reported on `main`, and does
 * nothing else. Pass `--apply` to actually write the protection rule.
 *
 * Requires the GitHub CLI (`gh`) authenticated with admin access to the repo.
 *
 *   bun scripts/setup-branch-protection.ts            # dry run (default)
 *   bun scripts/setup-branch-protection.ts --apply    # apply the ruleset
 *
 * Ruleset (see docs/superpowers spec / CONTRIBUTING.md):
 *   - Require a pull request before merging
 *   - Require 1 approving review + review from Code Owners
 *   - Dismiss stale approvals on new commits
 *   - Require status checks to pass (see REQUIRED_STATUS_CHECKS below)
 *   - Block force-push and branch deletion
 *   - Not enforced for administrators (owners can hotfix)
 */

const OWNER = 'mattapperson';
const REPO = 'noetic';
const BRANCH = 'main';

/**
 * Status-check contexts that must pass before merge. These are GitHub Actions
 * *job* names (not workflow names). Verify against the live names printed by the
 * dry run, and adjust here if a workflow's job is renamed.
 *   - "CI", "Structural gate"  → .github/workflows/ci.yml
 *   - "Check Signed-off-by"    → .github/workflows/dco.yml
 */
const REQUIRED_STATUS_CHECKS: readonly string[] = [
  'CI',
  'Structural gate',
  'Check Signed-off-by',
];

type ProtectionPayload = {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
  };
  enforce_admins: boolean;
  required_pull_request_reviews: {
    required_approving_review_count: number;
    require_code_owner_reviews: boolean;
    dismiss_stale_reviews: boolean;
  };
  restrictions: null;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  required_conversation_resolution: boolean;
};

const PAYLOAD: ProtectionPayload = {
  required_status_checks: {
    strict: true,
    contexts: [
      ...REQUIRED_STATUS_CHECKS,
    ],
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    require_code_owner_reviews: true,
    dismiss_stale_reviews: true,
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: false,
};

async function gh(
  args: string[],
  stdin?: string,
): Promise<{
  ok: boolean;
  out: string;
}> {
  const proc = Bun.spawn(
    [
      'gh',
      ...args,
    ],
    {
      stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: code === 0,
    out: out.trim() || err.trim(),
  };
}

async function printCurrentChecks(): Promise<void> {
  const res = await gh([
    'api',
    `repos/${OWNER}/${REPO}/commits/${BRANCH}/check-runs`,
    '--jq',
    '.check_runs[].name',
  ]);
  const names = res.ok
    ? [
        ...new Set(res.out.split('\n').filter(Boolean)),
      ]
    : [];
  console.log('\nStatus checks currently reported on the latest `main` commit:');
  if (names.length === 0) {
    console.log('  (none found — has CI run on main yet? names must match exactly)');
    return;
  }
  for (const name of names) {
    const required = REQUIRED_STATUS_CHECKS.includes(name);
    console.log(`  ${required ? '✔ (required)' : '  '} ${name}`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const auth = await gh([
    'auth',
    'status',
  ]);
  if (!auth.ok) {
    console.error('gh is not authenticated. Run `gh auth login` first.');
    process.exit(1);
  }

  console.log(`Target: ${OWNER}/${REPO} @ ${BRANCH}`);
  console.log('\nProtection payload:');
  console.log(JSON.stringify(PAYLOAD, null, 2));

  await printCurrentChecks();

  if (!apply) {
    console.log('\nDry run only. Re-run with `--apply` to write this protection rule.');
    console.log('Before applying, confirm every required check above is a real, exact name.');
    return;
  }

  console.log('\nApplying branch protection...');
  const res = await gh(
    [
      'api',
      '--method',
      'PUT',
      `repos/${OWNER}/${REPO}/branches/${BRANCH}/protection`,
      '--input',
      '-',
    ],
    JSON.stringify(PAYLOAD),
  );

  if (!res.ok) {
    console.error('Failed to apply branch protection:\n' + res.out);
    process.exit(1);
  }
  console.log('Branch protection applied. ✔');
  console.log(`Verify: gh api repos/${OWNER}/${REPO}/branches/${BRANCH}/protection`);
}

await main();
