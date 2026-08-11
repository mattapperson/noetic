# Frequently Asked Questions

This is the canonical FAQ for Noetic. It lives in the repo so it's reviewable,
forkable, and editable via pull request. (A maintainer may also mirror it to the
[GitHub Wiki](https://github.com/mattapperson/noetic/wiki) for discoverability.)

Have a question that isn't answered here? Open a
[discussion](https://github.com/mattapperson/noetic/discussions) or a
[PR](CONTRIBUTING.md) adding it below.

---

## What is Noetic?

Noetic is a TypeScript agent framework that decomposes AI agent patterns into a
small set of composable **step primitives** (`runCode`, `callModel`, `invokeTool`,
`conditional`, `inParallel`, `spawn`, `loop`, plus sub-harness kinds like
`claude-code`). It treats context-boundary management as a
first-class concern and ships a pluggable context system with well-defined
lifecycle hooks. Patterns like ReAct, Ralph Wiggum, and task trees are short
compositions of these primitives. See the [README](../README.md).

## How are the packages related?

Noetic is a Bun workspace monorepo under `packages/*`. The dependency direction
(arrows = "depends on"):

```
plugins → cli → code-agent → core ← eval
                              │
                              └→ context → types ← sub-harness ← sub-harness-{claude-code,codex,opencode,pi}
```

- `@noetic-tools/types` — dependency-free foundation (data model, contracts).
- `@noetic-tools/context` — the context-layer system.
- `@noetic-tools/core` — step primitives, interpreter, runtime.
- `@noetic-tools/eval` — evaluation and optimization.
- `@noetic-tools/cli` / `code-agent` — the TUI harness and tool implementations.

See [`CLAUDE.md`](../CLAUDE.md) and [`specs/00-overview.md`](../specs/00-overview.md)
for the full architecture.

## What runtime do I need?

[Bun](https://bun.sh). Bun is the canonical runtime and package manager, and
`bun.lock` is the only lockfile. In-workspace consumers resolve `@noetic-tools/*`
straight to `src/*.ts`, so no build step is needed for tests, typecheck, or the
CLI.

## How do I run the tests?

```bash
bun install
bun test                     # all package suites
cd packages/core && bun test # a single package
```

More commands are in [`CLAUDE.md`](../CLAUDE.md).

## How do I contribute?

Read [`CONTRIBUTING.md`](../CONTRIBUTING.md). In short: fork, branch from `main`,
make your change with tests, **sign off your commits** (`git commit -s`), and open
a pull request. Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/) with a package scope.

## Why do I have to sign off my commits (DCO)?

We use the [Developer Certificate of Origin](https://developercertificate.org/)
to certify that you have the right to contribute the code — a lightweight
alternative to a CLA. Adding `-s` to `git commit` appends a `Signed-off-by` line.
A CI check enforces it. See the [DCO section of CONTRIBUTING](../CONTRIBUTING.md#developer-certificate-of-origin-dco).

## What license is Noetic under?

[Apache License 2.0](../LICENSE). All packages are published under Apache-2.0, and
contributions are accepted inbound under the same license (per Apache-2.0 §5) with
a DCO sign-off. See [`NOTICE`](../NOTICE) for attribution.

## How do releases and versioning work?

Publishing is automated via semantic-release, driven by Conventional Commit
messages: a `feat` is a minor bump, a breaking change (with a `BREAKING CHANGE:`
footer) is a major, and everything else is a patch. `@noetic-tools/types`,
`context`, and `core` release in dependency order on push to `main`. See
[`.claude/rules/commit-conventions.md`](../.claude/rules/commit-conventions.md).

## How do I report a bug?

Open a [bug report](https://github.com/mattapperson/noetic/issues/new/choose)
using the issue form. Include the affected package, version, runtime, and a
minimal reproduction.

## How do I report a security vulnerability?

**Not** through a public issue. Use GitHub's private vulnerability reporting from
the [Security tab](https://github.com/mattapperson/noetic/security). See
[`SECURITY.md`](../SECURITY.md).

## Where is the source of architectural truth?

The [`specs/`](../specs/) directory. Runtime code is kept consistent with its
spec, and architectural boundaries are machine-enforced by `sentrux`
(`.sentrux/rules.toml`). Substantial features usually start with a spec change.
