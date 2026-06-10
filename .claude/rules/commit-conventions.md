# Commit Conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with scopes. Semantic-release reads these to determine version bumps for `@noetic-tools/core`.

## Format

```
<type>(<scope>): <subject>
```

## Types and Version Impact

**Default policy: every core change publishes at least a patch.** A breaking
change is a major, a `feat` is a minor, and *everything else* — `fix`, `perf`,
`refactor`, `build`, `chore`, `docs`, `test`, **and untyped/unrecognized
commits** (e.g. a squash-merge that dropped the prefix) — is a **patch**. A core
change never silently skips a release.

| Type | Version Bump |
|------|-------------|
| breaking (`!` / `BREAKING CHANGE:` footer) | **major** |
| `feat` | **minor** |
| everything else (incl. untyped) | **patch** |

> This is why a sloppy or squash-stripped commit message still cuts a patch
> rather than nothing. There is no per-commit "no release" type anymore; to skip
> a release entirely, either don't touch the release-triggering paths or add
> `[skip ci]` to the commit (which skips the workflow).

> Use a `BREAKING CHANGE:` footer for breaking changes — the `!` shorthand alone
> is not reliably detected by the analyzer and would only cut a patch.

## Scopes

Use the package name as scope when the change is package-specific:

- `feat(core):` — triggers `@noetic-tools/core` npm release
- `feat(cli):` — for `@noetic-tools/cli` changes
- `feat(code-agent):` — for `@noetic-tools/code-agent` changes
- `feat(eval):` — for `@noetic/eval` changes
- `chore(web):` — for website changes

Omit scope for cross-cutting changes: `refactor: split Node adapters`

## Breaking Changes

Append `!` after the scope for breaking changes (triggers major bump):

```
feat(core)!: rename Step.execute to Step.run
```

Use a `BREAKING CHANGE:` footer (the reliable signal); see the note above.

## Suppressing Releases

There is no per-commit type that suppresses a release — every core change is at
least a patch. To skip a release: don't touch the release-triggering paths
(`packages/core/**`, `biome.json`, `bun.lock`), or add `[skip ci]` to the commit
to skip the workflow entirely.

## What Triggers an npm Release

The `release-packages.yml` workflow runs on push to `main` when
`packages/types/**`, `packages/memory/**`, `packages/core/**`, `biome.json`,
or `bun.lock` changes. It releases the three packages as **sequential jobs in
dependency order (types → memory → core)** — never in parallel, so the
`chore: release` commit each job pushes back to main can't strand a sibling,
and a dependent never publishes pinned to a dependency version that isn't on
npm yet. Each job:
1. Runs lint, typecheck, build (plus dependency dists for memory/core)
2. Scans commits since the last `<pkg>-v*` tag (scoped to its package by
   `semantic-release-monorepo`)
3. Determines the version bump from commit types — **major** for breaking,
   **minor** for `feat`, **patch** for everything else (including untyped /
   squash-stripped commits)
4. Publishes to npm with provenance
5. Creates a GitHub release and git tag (`<pkg>-v<version>`)

> Note: because of `semantic-release-monorepo` scoping, a release is cut only
> when the analyzed commits touched `packages/core/**`. A change to *only*
> `biome.json`/`bun.lock` starts the workflow but won't publish unless a
> `packages/core` commit is in range (avoids publishing an identical tarball).

## Examples

```
feat(core): add JSON workflow runtime                  → minor (0.1.0 → 0.2.0)
fix(core): handle null in branch route matching        → patch (0.2.0 → 0.2.1)
refactor(core): simplify hydrator switch               → patch (0.2.1 → 0.2.2)
chore(core): update dev dependencies                   → patch (now releases)
"Combining the three commits into one message"         → patch (untyped → patch)
feat(core): drop FlowSchema\n\nBREAKING CHANGE: ...     → major (0.2.2 → 1.0.0)
feat(cli): add --resume flag                           → no core release (not packages/core)
```
