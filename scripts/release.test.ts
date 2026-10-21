import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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
  needs: z.string().optional(),
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

test('every merge to main can start a release', () => {
  expect(workflow.on.push.branches).toEqual([
    'main',
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

test('releases form one chain with dependencies before their consumers', () => {
  const released = new Set<string>();
  let previous: string | undefined;
  for (const [id, value] of jobs) {
    expect(value.needs).toBe(previous);
    const pkg = packages.find((entry) => entry.dir === `packages/${id}`)!;
    for (const name of Object.keys(pkg.dependencies)) {
      if (packages.some((entry) => entry.name === name)) {
        expect(released.has(name)).toBe(true);
      }
    }
    released.add(pkg.name);
    previous = id;
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
    expect(checkout.with?.ref).toBe('main');
    expect(checkout.with?.['fetch-depth']).toBe(0);
    expect(
      value.steps.some((step) => step.run === `bash scripts/publish-missing.sh ${pkg.dir}`),
    ).toBe(true);
    const config = JSON.parse(readFileSync(new URL(`${pkg.dir}/.releaserc.json`, root), 'utf8'));
    expect(config.tagFormat).toBe(`${id}-v\${version}`);
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
