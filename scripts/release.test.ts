import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const root = new URL('../', import.meta.url);
const manifest = z.object({
  name: z.string(),
  private: z.boolean().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
  scripts: z.record(z.string(), z.string()).default({}),
  publishConfig: z
    .object({
      access: z.string(),
    })
    .optional(),
});
const job = z.object({
  needs: z.array(z.string()).optional(),
  if: z.string().optional(),
  permissions: z.object({
    'id-token': z.string(),
  }),
  steps: z.array(
    z.object({
      uses: z.string().optional(),
      with: z
        .record(
          z.string(),
          z.union([
            z.string(),
            z.number(),
          ]),
        )
        .optional(),
      run: z.string().optional(),
      'working-directory': z.string().optional(),
    }),
  ),
});
const workflow = z
  .object({
    on: z.object({
      push: z
        .object({
          branches: z.array(z.string()),
        })
        .strict(),
      workflow_dispatch: z.null(),
    }),
    jobs: z.record(z.string(), job),
  })
  .parse(parse(readFileSync(new URL('.github/workflows/release-packages.yml', root), 'utf8')));
const packages = readdirSync(new URL('packages/', root), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    dir: `packages/${entry.name}`,
    ...manifest.parse(
      JSON.parse(readFileSync(new URL(`packages/${entry.name}/package.json`, root), 'utf8')),
    ),
  }))
  .filter((pkg) => !pkg.private);
const jobs = Object.entries(workflow.jobs);

test('every merge to main or next can start a release', () => {
  expect(workflow.on.push.branches).toEqual([
    'main',
    'next',
  ]);
  expect(workflow.on).toHaveProperty('workflow_dispatch');
});

test('every public workspace has exactly one release job', () => {
  const dirs = jobs.flatMap(([, value]) =>
    value.steps
      .filter((step) => step.run?.includes('semantic-release --extends'))
      .map((step) => step['working-directory']),
  );
  expect(dirs.sort()).toEqual(packages.map((pkg) => pkg.dir).sort());
});

/** The release jobs of the workspace packages `id` depends on. */
function dependencyJobs(id: string): string[] {
  const pkg = packages.find((entry) => entry.dir === `packages/${id}`)!;
  return Object.keys(pkg.dependencies).flatMap((name) => {
    const dependency = packages.find((entry) => entry.name === name);
    return dependency
      ? [
          dependency.dir.replace('packages/', ''),
        ]
      : [];
  });
}

test('releases form one chain with dependencies before their consumers', () => {
  const released = new Set<string>();
  let previous: string | undefined;
  for (const [id, value] of jobs) {
    // The job before it comes first in `needs`: one job writes to the branch at a time.
    expect(value.needs?.[0]).toBe(previous);
    for (const dependency of dependencyJobs(id)) {
      expect(released.has(dependency)).toBe(true);
    }
    released.add(id);
    previous = id;
  }
});

test('a job runs when its own dependencies were released, whatever the job before it did', () => {
  for (const [id, value] of jobs) {
    const dependencies = dependencyJobs(id);
    if (dependencies.length === 0) {
      expect(value.needs).toBeUndefined();
      expect(value.if).toBeUndefined();
      continue;
    }
    // Every dependency is named in `needs`, or its result could not be read.
    expect(
      [
        ...(value.needs ?? []),
      ].sort(),
    ).toEqual(
      [
        ...new Set([
          ...(value.needs ?? []).slice(0, 1),
          ...dependencies,
        ]),
      ].sort(),
    );
    const released = dependencies.map((job) => `needs.${job}.result == 'success'`).join(' && ');
    expect(value.if).toBe(`\${{ !cancelled() && ${released} }}`);
  }
});

test('every package has a public build and uses this workflow for trusted publishing', () => {
  for (const [id, value] of jobs) {
    const pkg = packages.find((entry) => entry.dir === `packages/${id}`)!;
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.prepublishOnly).toBeTruthy();
    expect(pkg.publishConfig?.access).toBe('public');
    expect(value.permissions['id-token']).toBe('write');
    const checkout = value.steps.find((step) => step.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.ref).toMatch(/^\$\{\{ github\.ref_name \}\}$/);
    expect(checkout.with?.['fetch-depth']).toBe(0);
    expect(
      value.steps.some((step) => step.run === `bash scripts/publish-missing.sh ${pkg.dir}`),
    ).toBe(true);
    const config = JSON.parse(readFileSync(new URL(`${pkg.dir}/.releaserc.json`, root), 'utf8'));
    expect(config.tagFormat).toBe(`${id}-v\${version}`);
    expect(config.branches).toEqual([
      'main',
      {
        name: 'next',
        prerelease: true,
        channel: 'next',
      },
    ]);
  }
});

test('no other workflow publishes npm packages', () => {
  for (const file of readdirSync(new URL('.github/workflows/', root))) {
    if (file === 'release-packages.yml') {
      continue;
    }
    const source = readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8');
    expect(source).not.toMatch(/\bnpm publish\b|\bsemantic-release --extends\b/);
  }
});

//#region publish-missing.sh

/** Run `command` in `cwd`, and fail the test with its output when it fails. */
function sh(cwd: string, command: string, env: Record<string, string> = {}): string {
  const result = spawnSync(
    'bash',
    [
      '-c',
      command,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), {
    recursive: true,
  });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A repository with `packages/base` and `packages/app` (which depends on base),
 * `app` tagged at 1.0.0 and never published, and `npm` and `bun` stubs on `PATH`
 * that log what they were asked to do.
 */
function taggedRepo(): {
  repo: string;
  log: string;
  env: Record<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), 'publish-missing-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const log = join(root, 'log');
  mkdirSync(bin, {
    recursive: true,
  });
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
if [[ $1 == view ]]; then echo '{"error":{"code":"E404"}}'; exit 1; fi
echo "npm $* | $(cat "$2/src.txt")" >> "${log}"
`,
  );
  writeFileSync(
    join(bin, 'bun'),
    `#!/usr/bin/env bash
echo "bun $*" >> "${log}"
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'bun'), 0o755);
  writeJson(join(repo, 'package.json'), {
    name: 'root',
    private: true,
    workspaces: [
      'packages/*',
    ],
  });
  writeFileSync(join(repo, 'bun.lock'), 'lock\n');
  writeJson(join(repo, 'packages/base/package.json'), {
    name: '@x/base',
    version: '2.0.0',
  });
  writeJson(join(repo, 'packages/app/package.json'), {
    name: '@x/app',
    version: '1.0.0',
    dependencies: {
      '@x/base': 'workspace:*',
    },
  });
  writeFileSync(join(repo, 'packages/app/src.txt'), 'as tagged');
  sh(
    repo,
    'git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git tag app-v1.0.0',
  );
  return {
    repo,
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
  };
}

const PUBLISH_MISSING = new URL('publish-missing.sh', import.meta.url).pathname;

test('publish-missing publishes the checkout when it is still the tag', () => {
  const { repo, log, env } = taggedRepo();
  try {
    sh(repo, `bash ${PUBLISH_MISSING} packages/app`, env);
    expect(readFileSync(log, 'utf8').trim()).toBe(
      'npm publish ./packages/app --access public --provenance --workspaces=false --tag latest | as tagged',
    );
  } finally {
    rmSync(join(repo, '..'), {
      recursive: true,
      force: true,
    });
  }
});

test('publish-missing rebuilds a moved-on checkout from the tag, dependencies first', () => {
  const { repo, log, env } = taggedRepo();
  try {
    writeFileSync(join(repo, 'packages/app/src.txt'), 'moved on');
    sh(repo, 'git -c user.name=t -c user.email=t@t commit -qam later');
    sh(repo, `bash ${PUBLISH_MISSING} packages/app`, env);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.slice(0, 2)).toEqual([
      'bun install',
      'bun run --cwd packages/base build',
    ]);
    // The tag's sources, from a checkout of its own, without provenance naming this commit.
    expect(lines[2]).toMatch(
      /^npm publish \S+\/src\/packages\/app --access public --provenance=false --workspaces=false --tag latest \| as tagged$/,
    );
    expect(lines).toHaveLength(3);
    // The temporary checkout is removed.
    expect(sh(repo, 'git worktree list').trim().split('\n')).toHaveLength(1);
  } finally {
    rmSync(join(repo, '..'), {
      recursive: true,
      force: true,
    });
  }
});

test('publish-missing does nothing for a version that was never tagged', () => {
  const { repo, log, env } = taggedRepo();
  try {
    sh(repo, 'git tag -d app-v1.0.0 >/dev/null');
    sh(repo, `bash ${PUBLISH_MISSING} packages/app`, env);
    expect(readFileSync(log, 'utf8')).toBe('');
  } finally {
    rmSync(join(repo, '..'), {
      recursive: true,
      force: true,
    });
  }
});

//#endregion
