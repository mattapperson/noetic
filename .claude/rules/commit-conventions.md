# Commit Conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with scopes. Semantic-release reads these to determine version bumps for `@noetic-tools/core`.

## Format

```
<type>(<scope>): <subject>
```

## Types and Version Impact

| Type | Version Bump | When to use |
|------|-------------|-------------|
| `feat` | **minor** | New feature or public API addition |
| `fix` | patch | Bug fix |
| `perf` | patch | Performance improvement |
| `refactor` | patch | Code restructuring without behavior change |
| `build` | patch | Build system, deps, or tooling changes |
| `chore` | none | Maintenance tasks (no release) |
| `docs` | none | Documentation only |
| `test` | none | Test additions/fixes only |

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

Or include `BREAKING CHANGE:` in the commit body.

## Suppressing Releases

Use `scope: no-release` or type `chore`/`docs`/`test` for commits that should NOT trigger a release even when touching `packages/core/`.

## What Triggers a Core npm Release

The `release-core.yml` workflow runs on push to `main` when `packages/core/**` changes. It:
1. Runs lint, typecheck, build
2. Scans commits since last `core-v*` tag
3. Determines the version bump from commit types
4. Publishes to npm with provenance
5. Creates a GitHub release and git tag (`core-v<version>`)

## Examples

```
feat(core): add JSON workflow runtime                  → minor (0.1.0 → 0.2.0)
fix(core): handle null in branch route matching        → patch (0.2.0 → 0.2.1)
refactor(core): simplify hydrator switch               → patch (0.2.1 → 0.2.2)
chore(core): update dev dependencies                   → no release
feat(core)!: remove deprecated FlowSchema export       → major (0.2.2 → 1.0.0)
feat(cli): add --resume flag                           → no core release
```
