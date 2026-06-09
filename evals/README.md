# Noetic Evals

End-to-end evaluations that run real Noetic agents against external benchmarks.

Unlike the per-package eval suites under `packages/eval/evals/` (which exercise
the eval framework itself), these run the **shipping agents** — currently the
`@noetic-tools/code-agent` — against published research benchmarks.

## LongMemEval (`longmem/`)

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) benchmarks
chat assistants on long-term interactive memory. Each question ships with a
"haystack" of prior chat sessions; the assistant must answer using evidence
buried in that history.

This eval drives the real `createCodeAgent()` harness (full Noetic memory stack)
against the **oracle** split — the smallest official variant (~15 MB, evidence
sessions only) — and grades answers with a LongMemEval-style LLM judge.

### Setup

```bash
# 1. Install workspace deps (from the repo root)
bun install

# 2. Build @noetic-tools/core (it resolves via its compiled dist/, not src/)
bun --cwd packages/core run build

# 3. Download the smallest (oracle) dataset into longmem/data/
bun evals/longmem/download.ts

# 4. Make sure an OpenRouter key is available
export OPENROUTER_API_KEY=sk-or-...
```

> **Why the build step?** `@noetic-tools/core`'s `package.json` `exports` field
> points at `./dist/*.js`, so it must be compiled once before anything that
> imports it can resolve. `code-agent` and `eval` resolve straight from their
> `src/`, so only `core` needs building.

### Run

```bash
# Standalone runner (smallest run: one question)
bun evals/longmem/run.ts

# A few questions, a specific type, a specific model
bun evals/longmem/run.ts --limit 5
bun evals/longmem/run.ts --type temporal-reasoning --limit 3
bun evals/longmem/run.ts --model ~anthropic/claude-sonnet-latest --judge-model openai/gpt-4o
```

Or through the `@noetic/eval` framework:

```bash
LONGMEM_LIMIT=1 bunx noetic test evals/longmem/longmem.eval.ts
```

### Results

Full oracle split (all 500 questions) against live OpenRouter:

| Date | Agent model | Judge model | Questions | Score | Cost |
|------|-------------|-------------|-----------|-------|------|
| 2026-05-31 | `~anthropic/claude-sonnet-latest` | `openai/gpt-4o` | 500 (full oracle) | **440/500 (88.0%)** | $11.85 (~$0.024/question) |

Accuracy by question type:

| Question type | Score | |
|---------------|-------|--|
| `single-session-assistant` | 56/56 | 100% |
| `single-session-user` | 68/70 | 97% |
| `single-session-preference` | 26/30 | 87% |
| `knowledge-update` | 66/78 | 85% |
| `multi-session` | 112/133 | 84% |
| `temporal-reasoning` | 112/133 | 84% |

All 500 questions were graded (the runner tolerates a per-question failure and
excludes it from the denominator; this run had zero such failures). The agent
reads the full session haystack from the prompt and answers in one turn
(~8.7k–10.7k input + ~100 output tokens per question). The two hardest
categories are `multi-session` (evidence spread across sessions) and
`temporal-reasoning` (comparing session timestamps).

## Memory-layer investigation (in progress — paused)

Goal: push accuracy toward ≥98% by making the **memory layers** do the
context-window distillation (map/reduce), rather than dumping the whole haystack
into one prompt. `FINDINGS.md` has the full working notes; summary below.

### What we learned

1. **In single-turn QA the built-in memory layers do nothing.** Instrumenting
   `ctx.lastLayerUsage` showed `layers: []` — 100% of the context is raw history
   passing straight through. The distilling layers (`observationalMemory`,
   `workingMemory`) only act in their `store` hook, gated on a buffer threshold
   that accumulates across *many* turns; `historyWindow` only caps at 400 items.
   None fire on a one-shot question. So today there is **zero distillation**.

2. **Failure taxonomy (the 60 misses, from the baseline run):**
   counting/coverage 31, fact-recall 10, temporal arithmetic 7, abstention 7,
   knowledge-update 5. Counting dominates — "how many X" where instances are
   scattered across sessions and the model under/over-counts in prose.

3. **Oracle haystacks are small** (avg 1.9 sessions, max 6). So the dominant
   failure is **not** "too much context" — even small context is miscounted in
   prose. The lever is **restructuring** (atomic, deduplicated, dated fact
   ledger), not just reduction.

4. **Prototype distillation layer** (`distill.ts`: extract → `<known_facts>`
   ledger at recall time, drop raw transcript via `projectHistory`):
   - v1 (with a "deduplicate" rule): recovered **22/60** of prior failures
     (~92% projected overall). The map step was *lossy on countable instances* —
     it merged distinct items (clothing 3→2, projects 2→1, festivals 4→3).
   - v2 ("emit every distinct instance, never merge"): **regressed** on the
     counting slice (1/6 vs v1's 2/7) — over-listing confused the answerer as
     much as under-merging did. Neither extractor variant reliably fixes
     counting; the answerer still picks the wrong total from the ledger.
   - v3 (v1 extractor + **enumerate-then-count answerer**: list every matching
     instance, then count the list): **29/60 recovered** — up from v1's 22. The
     lever was the *answerer* prompt, not the extractor.
   - v4 (**additive ledger**: keep the raw transcript AND inject the fact ledger,
     `replaceHistory: false`): **31/60 recovered (51.7%)** — +2 over v3.
     knowledge-update 5→7, preference 0→1; cost one temporal. Keeping the raw
     source is the better default, but the hoped-for preference recovery (1/4)
     didn't materialize.

### Where this leaves it

- **Shipped + verified:** `X-OpenRouter-Cache` support in core
  (`LlmProviderConfig.cache` / code-agent `llm.cache`) — identical model calls
  aren't re-billed (verified $0.0002 → $0 on repeat). Committed.
- **Best result:** v4 recovers 31/60 failures → **~94.2% projected overall**
  (88% → 94.2%), *assuming no regression on the 440 prior-passing questions —
  not yet validated* (needs a full-500 distillation run). Below the ≥98% goal,
  which also exceeds published LongMemEval SOTA (~96%).
- **Plateau:** the two residual classes aren't memory problems —
  temporal-reasoning is date arithmetic, and preference questions want the raw
  source, not distillation. Reaching 98% needs per-question-type routing + a
  separate temporal step (orchestration beyond the memory layer), not more
  distillation tuning.
- **Prototype, not ported:** the distillation layer lives in `distill.ts`
  (eval-space). It has two single-turn-specific designs (recall-time extraction,
  history-replacing `projectHistory`) that must change before porting to core's
  built-in layers — see `FINDINGS.md` "Porting to core".
- **Next steps:** (1) validate against the full 500 to confirm no regressions;
  (2) attack temporal-reasoning (a date-arithmetic step, separate from memory);
  (3) port the layer to core per the FINDINGS notes.

Best result so far on the failing subset: **22/60 recovered (v1)**. Not yet at
the ≥98% target; the work is paused here, not complete.

### Layout

| File | Purpose |
|------|---------|
| `download.ts` | Fetches the oracle split into `data/` |
| `dataset.ts` | Zod-validated loader + transcript formatting |
| `agent.ts` | Drives `createCodeAgent()` on one question |
| `judge.ts` | LongMemEval-style correctness judge |
| `run.ts` | Standalone CLI runner with accuracy summary |
| `longmem.eval.ts` | `@noetic/eval` suite (`describe`/`it.each`/`scorer`) |

### Knobs

| Env | Default | Meaning |
|-----|---------|---------|
| `OPENROUTER_API_KEY` | — | Required for live runs |
| `LONGMEM_MODEL` | `~anthropic/claude-sonnet-latest` | Agent model |
| `LONGMEM_LIMIT` | `1` | Number of questions (eval suite) |
| `LONGMEM_TYPE` | — | Filter by question type (eval suite) |
| `NOETIC_JUDGE_MODEL` | `openai/gpt-4o` | Judge model |

The dataset files are git-ignored (too large to commit); re-run `download.ts` to
fetch them.
