<!--
Thanks for contributing to Noetic! Please fill out the sections below.
See CONTRIBUTING.md for the full process.
-->

## Summary

<!-- What does this PR do and why? -->

## Related issue

<!-- e.g. Closes #123. If there's no issue, briefly explain the motivation above. -->

## Type of change

- [ ] Bug fix (`fix:`)
- [ ] New feature (`feat:`)
- [ ] Refactor / internal (`refactor:`, `chore:`, `perf:`)
- [ ] Docs (`docs:`)
- [ ] Breaking change (includes a `BREAKING CHANGE:` footer)

## Checklist

- [ ] My commits are **signed off** (DCO): `git commit -s` — the DCO check must pass.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      with a package scope (e.g. `feat(core): ...`).
- [ ] Tests added or updated, and `bun test` passes.
- [ ] `bun run lint` and `typecheck` pass.
- [ ] Specs/docs updated where behavior changed
      (see `.claude/rules/sync-spec-code-docs.md`).
- [ ] `sentrux gate .` is clean (no new architecture violations).
- [ ] If I added a package or a new top-level directory, I updated
      `.sentrux/rules.toml` in the same commit.

## Notes for reviewers

<!-- Anything that needs special attention, trade-offs, follow-ups, etc. -->
