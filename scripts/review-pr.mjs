import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const upstream = 'https://github.com/fatwang2/jev-review-action.git';
const revision = '929b99227431f0a35752d4860e9ba7c36abe5bda';
const decisionsUrl = 'https://openrouter.ai/api/alpha/decisions';
const prUrl = /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/;

try {
  await main();
} catch (error) {
  console.error(`Jev review: ${error.message}`);
  process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'check-policy': {
        type: 'boolean',
      },
      json: {
        type: 'boolean',
      },
      help: {
        type: 'boolean',
      },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/review-pr.mjs [PR number or GitHub URL] [--json | --check-policy]',
    );
    return;
  }
  const [ref] = positionals;
  if (positionals.length > 1 || (ref && !/^[1-9]\d*$/.test(ref) && !prUrl.test(ref))) {
    throw new Error('Pass one PR number or a github.com pull request URL.');
  }

  const root = run(
    'git',
    [
      'rev-parse',
      '--show-toplevel',
    ],
    process.cwd(),
  );
  const catalog = join(root, '.repo-rules.json');
  if (!(await lstat(catalog)).isFile()) {
    throw new Error('.repo-rules.json must be a regular file at the checkout root.');
  }
  const rules = JSON.parse(await readFile(catalog, 'utf8'));
  const checkout = await mkdtemp(join(tmpdir(), 'noetic-jev-review-'));
  try {
    await review({
      checkout,
      ref,
      root,
      rules,
      flags: values,
    });
  } finally {
    await rm(checkout, {
      recursive: true,
      force: true,
    });
  }
}

async function review({ checkout, ref, root, rules, flags }) {
  run(
    'git',
    [
      'init',
      '--quiet',
    ],
    checkout,
  );
  run(
    'git',
    [
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      upstream,
      revision,
    ],
    checkout,
  );
  if (
    run(
      'git',
      [
        'rev-parse',
        'FETCH_HEAD',
      ],
      checkout,
    ) !== revision
  ) {
    throw new Error('Jev reviewer revision does not match the pin.');
  }
  run(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '--quiet',
      '--detach',
      revision,
    ],
    checkout,
  );
  const load = (file) => import(pathToFileURL(join(checkout, 'src', file)).href);
  const { validatePolicy } = await load('policy.mjs');
  const policy = validatePolicy(rules);
  if (policy.mode !== 'pull-request') {
    throw new Error('.repo-rules.json must use pull-request mode.');
  }
  if (flags['check-policy']) {
    console.log(`Validated .repo-rules.json (${policy.checks.length} checks).`);
    return;
  }

  const [{ GitHub, collectPullRequest }, { judgeConfig }, { review }, { renderComment }] =
    await Promise.all([
      load('github.mjs'),
      load('jev.mjs'),
      load('review.mjs'),
      load('render.mjs'),
    ]);
  const useOpenRouter =
    !process.env.JEV_PROVIDERS && process.env.TYPESAFE_BASE_URL === decisionsUrl;
  const judge = judgeConfig({
    providers: process.env.JEV_PROVIDERS,
    typesafeApiKey: process.env.TYPESAFE_API_KEY,
    typesafeModel: process.env.JEV_TYPESAFE_MODEL,
    aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
    aiGatewayModel: process.env.AI_GATEWAY_MODEL,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
    cloudflareModel: process.env.CLOUDFLARE_AI_MODEL,
  });
  const view = JSON.parse(
    run(
      'gh',
      [
        'pr',
        'view',
        ...(ref
          ? [
              ref,
            ]
          : []),
        '--json',
        'url',
      ],
      root,
    ),
  );
  const [, repository, id] = prUrl.exec(view.url) ?? [];
  if (!repository) {
    throw new Error('Select a PR hosted on github.com.');
  }
  const pullRequest = Number(id);
  const token =
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    run(
      'gh',
      [
        'auth',
        'token',
        '--hostname',
        'github.com',
      ],
      root,
    );
  const github = new GitHub(token);
  const pull = await github.pull(repository, pullRequest);
  if (pull.state !== 'open') {
    throw new Error('Select an open PR.');
  }
  const files = await github.changedFiles(repository, pullRequest);
  if (files.length !== pull.changed_files) {
    throw new Error('GitHub returned an incomplete file list.');
  }
  const current = await github.pull(repository, pullRequest);
  if (!sameRevision(pull, current)) {
    throw new Error('The PR changed while its diff was being fetched. Run the review again.');
  }
  const report = await review({
    policy,
    judge,
    fetchImpl: useOpenRouter ? fetchDecisions : undefined,
    collected: collectPullRequest(pull, files),
    context: {
      repository,
      pullRequest,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
    },
  });
  if (useOpenRouter) {
    report.judge = 'openrouter';
  }
  if (!sameRevision(pull, await github.pull(repository, pullRequest))) {
    throw new Error('The PR changed during the review. Run the review again.');
  }
  console.log(flags.json ? JSON.stringify(report, null, 2) : renderComment(report));
}

// OpenRouter uses the same Jev question and answer shapes with a namespaced model.
function fetchDecisions(url, request) {
  if (url !== 'https://api.typesafe.ai/v1/systemone') {
    throw new Error('Expected a TypeSafe Jev request.');
  }
  const model = process.env.TYPESAFE_MODEL || 'typesafe/jev-1.13';
  if (!/^typesafe\/jev-[\w.-]+$/.test(model)) {
    throw new Error('TYPESAFE_MODEL must name a Jev model on OpenRouter.');
  }
  return fetch(decisionsUrl, {
    ...request,
    body: JSON.stringify({
      ...JSON.parse(request.body),
      model,
    }),
  });
}

function sameRevision(before, after) {
  return (
    after.state === 'open' &&
    before.head.sha === after.head.sha &&
    before.base.sha === after.base.sha &&
    before.title === after.title &&
    before.body === after.body
  );
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
      timeout: 60_000,
    }).trim();
  } catch {
    throw new Error(
      `Could not run ${command} ${args[0]}. Check that ${command} is available and configured.`,
    );
  }
}
