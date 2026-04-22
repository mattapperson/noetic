# Upstream reference files

The `.reference` files in this directory are verbatim copies from
[Claude Code](https://github.com/anthropics/claude-code)
(`src/components/LogSelector.tsx`, `src/components/SessionPreview.tsx`,
`src/components/TagTabs.tsx`, `src/screens/ResumeConversation.tsx`).

They are kept here as **design references only** — they are React-compiler
output (with `_c(...)` cache slot arrays) and are hard-wired to Claude Code's
custom Ink fork, `design-system/`, `useKeybinding`, `AppState`, `REPL`, and
`feature()` flag plumbing. They **do not** compile as-is in this codebase.

The adapted siblings in `packages/cli/src/tui/components/resume/` are the
files that actually build and ship. They preserve the upstream UX (same
keybindings, tree grouping by date, same-project toggle, tag tabs, row
format) while being rewritten against Ink 7, Noetic's theme, and
`SessionMetadata`/`SessionFile` types.

The `.reference` extension prevents TypeScript from attempting to compile
them.
