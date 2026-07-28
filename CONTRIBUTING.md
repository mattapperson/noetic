# Contributing to Noetic

Thanks for your interest in contributing! This guide covers how to get set up, the
conventions this repo enforces, and how to get a pull request merged.

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- [Bun](https://bun.sh) — the canonical runtime and package manager for this repo.
  `bun.lock` is the only lockfile; do not add `package-lock.json` or `pnpm-lock.yaml`.

## Getting started

```bash
git clone https://github.com/mattapperson/noetic.git
cd noetic
bun install        # installs workspace deps (postinstall patches the SDK)
bun test           # run the package test suites
```

Useful commands (see [`CLAUDE.md`](CLAUDE.md) for the full reference):

```bash
bun test                      # all package suites (sequential)
bun run lint                  # Biome check across the repo
bun run lint:fix              # auto-fix lint issues
cd packages/core && bun run typecheck   # tsc --noEmit for a package
```

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) to
certify that you wrote or otherwise have the right to submit the code you contribute —
there is no separate CLA to sign. Every commit must be signed off:

```bash
git commit -s -m "feat(core): add my feature"
```

The `-s` flag appends a trailing line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your Git author identity. A CI check
(`.github/workflows/dco.yml`) fails any pull request that contains a commit without a
valid `Signed-off-by` line.

Forgot to sign off? Amend the last commit with `git commit --amend -s --no-edit`, or
sign off a range with `git rebase --signoff <base>`.

## Making changes

1. **Fork** the repo and create a topic branch from `main`.
2. Make your change, following the repo conventions (below).
3. Add or update tests — see [`.claude/rules/testing.md`](.claude/rules/testing.md).
4. Keep specs and docs in sync — see
   [`.claude/rules/sync-spec-code-docs.md`](.claude/rules/sync-spec-code-docs.md).
   `specs/` is the source of architectural truth.
5. Ensure lint, typecheck, and tests pass locally.
6. Open a pull request and fill out the template.

## Conventions

This repo enforces several conventions, documented under
[`.claude/rules/`](.claude/rules/):

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/)
  with a package scope, e.g. `feat(core): ...`, `fix(cli): ...`. Semantic-release reads
  these to determine version bumps. See
  [`.claude/rules/commit-conventions.md`](.claude/rules/commit-conventions.md).
- **Type safety** — no `any`; validate external data with Zod. See
  [`.claude/rules/type-safety.md`](.claude/rules/type-safety.md).
- **Code structure** — early returns, small single-purpose functions, handler registries
  over long if-chains. See [`.claude/rules/code-structure.md`](.claude/rules/code-structure.md).
- **Architecture boundaries** are machine-enforced by `sentrux`. Run `sentrux gate .`
  before pushing; adding a package or a new top-level directory requires an update to
  `.sentrux/rules.toml` in the same commit.

## Pull request review

- PRs require **one approving review**, including review from a
  [code owner](.github/CODEOWNERS), before merging to `main`.
- Required status checks (CI, DCO) must pass.
- Pushing new commits dismisses stale approvals, so re-request review after changes.

### A note for fork-based contributors

When you open a PR from a fork, CI runs with a **read-only token and no access to
repository secrets** — this is the safe default and is expected. A maintainer may need
to approve the first workflow run on your PR. Live/integration tests that require API
keys are skipped in that context and are validated by a maintainer.

## FAQ

Common questions are answered in the [FAQ](docs/FAQ.md). If your question isn't there,
open a [discussion or issue](https://github.com/mattapperson/noetic/issues).
