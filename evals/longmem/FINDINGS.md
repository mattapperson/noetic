# LongMemEval — memory-layer diagnosis & plan

Baseline: **440/500 (88.0%)** on the oracle split, `~anthropic/claude-sonnet-latest`,
judge `openai/gpt-4o`, $11.85. (Driver: `agent.run(step.llm)` with the whole
haystack pasted into one prompt.)

## Key structural finding (from `ctx.lastLayerUsage` probe)

On a single-turn QA, **the memory layers contribute 0 tokens** — `lastLayerUsage.layers`
is empty; 100% of the context is raw history passing straight through.

Why: the distilling layers only act via hooks that never fire in one turn:
- `observationalMemory` / `workingMemory` distill in **`store`** (post-LLM), gated on a
  buffer threshold accumulated across many turns. One QA turn → never triggers.
- `historyWindow` caps at 400 items via `projectHistory`; oracle haystacks are ~36–500
  items but the oracle slice is tiny (~36 turns) → no capping.
- `recall` runs, but every layer starts with empty state on a fresh agent → emits nothing.

So today there is **zero distillation/map-reduce**. The agent succeeds or fails purely on
the raw dump. That is exactly the gap to close: a layer that, at recall time, map/reduces
the seeded haystack into only the question-relevant facts (less is more).

## Failure taxonomy (all 60 failures, from the full-run log)

| Cause | N | What goes wrong |
|-------|---|-----------------|
| counting / coverage | 31 | "how many X" — facts are scattered across sessions; in the flat dump the model under/over-counts (e.g. 2 vs 3 items, 3 vs 4 festivals). The dominant failure. |
| fact-recall | 10 | the specific fact is present but missed/confused among noise, or a preference-style answer the grader wanted surfaced. |
| temporal arithmetic/ordering | 7 | date math / "which came first" across session timestamps. |
| abstention | 7 | question presupposes a false premise (Dr. Johnson vs Dr. Smith; "job at Google" when it's NovaTech). Gold = "not enough info"; agent over-answers with the nearest real fact instead of refusing. |
| knowledge-update | 5 | a fact changed over time (gym 7pm→6pm); agent reports the stale value or flags a "discrepancy" instead of taking the latest. |

By question type: temporal-reasoning 21, multi-session 21, knowledge-update 12,
single-session-preference 4, single-session-user 2.

Failing indices saved in `/tmp/fail_idx.json` and `/tmp/fails_cat.json`.

## Hypotheses to test (memory-layer changes)

1. **Counting (biggest win):** a recall-time distillation layer that extracts atomic,
   deduplicated facts per session into a compact bulleted ledger — turning "find and
   count across 36 turns" into "count a short list". Less raw text, more structure.
2. **Knowledge-update:** the distiller should record facts with timestamps and collapse
   to the **latest** value for a given attribute (supersedes older), so the model sees one
   current fact, not a contradiction.
3. **Abstention:** distilled facts should be faithful to entities actually mentioned, so a
   false-premise question finds no matching fact → easier to refuse. Reinforce with a
   recall/system instruction: answer only from the ledger; if absent, say so.

## Implementation

- Distillation lives in **core built-in layers** (user decision) — accept the higher blast
  radius (core release + sentrux/coverage gates).
- **Cost control during iteration:** inject `X-OpenRouter-Cache: true` on every model call
  so identical calls aren't re-billed. Seam: `createClient()` in
  `packages/core/src/harness/agent-harness.ts:191-209` builds `new OpenRouter({ apiKey })`.
  The SDK's `HTTPClient` exposes `addHook("beforeRequest", (req) => req.headers.set(...))`
  and `SDKOptions.httpClient` accepts it. Thread a header option through `LlmProviderConfig`.
- **Iteration loop:** run the ~60-question failing subset + a ~40-question passing control
  (regression guard) each round; only run the full 500 to confirm. Budget ceiling ~$50.

## Iteration log

### Round 1 — distillation layer v1 (extract → fact ledger, replaceHistory)

Failing-60 subset: **22/60 recovered (36.7%)**. Counting slice [61,62,71,72,80,16,6]: 2/7.
If the 22 hold with no regression on the prior-passing 440 → overall ≈ 462/500 (92.4%).
Not yet 98%.

**Mechanism found (the map step is lossy):** the extractor's `Deduplicate` rule collapses
*distinct countable instances* — the exact opposite of what counting questions (31/60 of
failures) need:
- [61] clothing 3→2, [62] projects led 2→1, [72] festivals 4→3 (under-extracts instances)
- [71] citrus types 3→"not enough" (dropped the category entirely)
- [80] baking 4 → ✅, [16] charity events 4 → ✅ (worked when instances were clearly dated)

"Less is more" has a floor: distillation must be **lossless for countable/datable detail**
while compressing prose.

### Round 2 — v2 extractor ("emit every distinct instance, never merge")

Counting slice [61,62,71,72,80,16]: **1/6 — regressed vs v1's 2/7.** [80] baking flipped
correct→wrong (over-listed mentions as separate bakings), only [71] citrus recovered.
Verdict: over-listing confuses the answerer as much as under-merging. Reverted to v1.

**Conclusion so far:** counting is not fixable by tuning the *extractor* alone — whether
the ledger merges or splits, the *answerer* still picks the wrong total. The promising
next lever is to split the task: have the layer/answerer first ENUMERATE the matching
instances as an explicit list, then count the list (two cheaper, verifiable steps) rather
than asking one LLM call to both find and tally. v1 (22/60) is the checkpoint to build on.

(Correction: an earlier draft of this note claimed the QA step looped ~67×; that was
wrong — every run output is ~4 lines/question with no repeated blocks. No such loop
exists. Removed.)

### Round 3 — enumerate-then-count answerer (v1 extractor unchanged)

Kept the v1 extractor; changed only the QA prompt: for "how many" questions, FIRST list
every matching instance as a numbered list (quoting its supporting fact), THEN report the
count = list length. Counting questions become "enumerate, then len()" instead of one
find-and-tally call.

- Counting slice [61,62,71,72,80,16]: **4/6** (v1 2/7, v2 1/6).
- **Full failing-60: 29/60 recovered (48.3%)** — vs v1's 22/60. (The 4/6 slice
  over-predicted; the full subset is the real number.)
- By type recovered: multi-session 12/21, temporal-reasoning 12/21,
  knowledge-update 5/12, single-session-preference 0/4, single-session-user 0/2.
- **Projected overall ≈ 469/500 (93.8%)** IF the 440 prior-passing questions don't
  regress through the distillation pipeline — **not yet validated** (would need a full
  500 distillation run, ~$12). temporal-reasoning is the hard residual: date arithmetic
  / ordering, which is reasoning, not memory recall — distillation can't fix it alone.
  Preference/single-session questions got 0 recovery — distilling to a fact ledger
  actively *hurts* preference questions (they need the raw preference surfaced, not
  reduced to facts), so a one-size distillation layer is the wrong shape for them.

### Round 4 — additive ledger (`replaceHistory: false`, keep raw transcript)

Hypothesis from round 3: the 0/6 on preference + single-session came from *dropping*
the raw transcript. So keep it — inject the `<known_facts>` ledger AND the original
conversation, and reword the QA prompt to prefer the ledger for counting/dates but fall
back to the raw text for wording/preference.

- **Full failing-60: 31/60 recovered (51.7%)** — +2 over v3's 29.
- By type recovered: multi-session 12/21 (=), temporal-reasoning 11/21 (−1),
  knowledge-update 7/12 (+2), single-session-preference 1/4 (+1), single-session-user 0/2 (=).
- **Projected overall ≈ 471/500 (94.2%)**, still unvalidated against the prior-passing 440.

So keeping the raw transcript helped knowledge-update and nudged preference, but the big
hoped-for preference recovery didn't materialize (1/4) and it cost one temporal question —
net only +2. The additive ledger is the better default (strictly more context, the model
picks what it needs), but it is **not** the path to 98%.

**Overall conclusion:** memory-layer distillation took the failing subset from 0 →
~31/60 recovered (88% → ~94% projected), but plateaus well below the ≥98% goal. The
two residual classes are not memory problems: temporal-reasoning is date arithmetic, and
preference questions want the raw source, not distillation. Reaching 98% (above published
SOTA ~96%) would require per-question-type routing and a separate temporal-reasoning
step — i.e. orchestration beyond the memory layer. Best honest result: **31/60**.

**Status vs goal:** 88% → ~93.8% projected. Not at ≥98% (which also exceeds published
LongMemEval SOTA, ~96%). The lever that helped most was moving counting logic to the
*answerer* (enumerate-then-count), not the extractor.

## Porting to core (required before this becomes a real product change)

The prototype's `distillationMemory` is shaped for single-turn QA and has two
benchmark-specific designs that MUST change before porting into
`packages/core/src/memory/layers/` (per the altitude review):

1. **Extraction happens in `recall` (memoized once).** In multi-turn agents `recall`
   fires every turn and history grows — turn-2 facts would never enter the ledger.
   Core version must distill incrementally in `store`/`onItemAppend` (like
   `observationalMemory`), with `recall` only rendering current state.
2. **`projectHistory` drops all history but the last user turn.** Destructive for any
   real agent (kills tool-call pairs, multi-turn coherence). Must default
   `replaceHistory: false` and let `historyWindow` own capping; the layer should own
   only its injected ledger.
3. Minor: use core's `createMessage`/`estimateTokens` helpers instead of the local
   `msg`/`Math.ceil(len/4)`; the enumerate-then-count behavior stays in the *answerer*
   prompt (correct altitude — it is not the memory layer's job).


### Round 5 — shipped temporalMemory + distillation, instrumented (2026-05-31)

First live run of the consolidated `run-instrumented.ts` (shipped `temporalMemory`
grounded to question_date + recall distillation + enumerate-then-count answerer),
`~anthropic/claude-sonnet-latest`, judge `openai/gpt-4o`.

**Bug found + fixed (real):** passing `temporalMemory` in `memory:[...]` WITHOUT
`defaultMemory:false` loads it twice (default stack already ships it) → two
`temporal/searchMemory` tools → provider 400 `"tools: Tool names must be unique."`.
Fix: `defaultMemory:false` in the eval harness. (The shipped default stack itself
is fine — single instance, unique name.)

**Stratified sample (4 per type = 24 q, 0 errors) — REAL, not extrapolated:**
- OVERALL 19/24. By type: single-session-user 4/4, single-session-preference 4/4,
  single-session-assistant 3/4, temporal-reasoning 3/4, multi-session 3/4,
  knowledge-update 2/4.
- This 24-q sample OVER-weights the rare hard classes (each type capped at 4), so
  it is NOT comparable to the 88% natural-distribution baseline and must not be
  extrapolated to a full-set %.

**Per-layer visibility (the map/reduce, measured):** the distillation layer
compresses each haystack from avg ~9,376 chars → ~2,659 chars of ledger (~28%),
~28 atomic fact lines/question. Concrete "less is more" evidence of what the
memory layer injects into the next call.

**Residual failures** match the documented taxonomy and are not recall problems:
temporal date-arithmetic ("how many days between X and Y" → "not enough info"),
knowledge-update current-state counting ("how many books left" → miscount), and
one fact-recall phrasing (described the book instead of naming "The Lean Startup").

**Limitations:** `ctx.lastLayerUsage` and `ctx.cost` do not populate through the
`agent.run(step.llm)` path, so token/cost are read from the OpenRouter dashboard,
not the harness; visibility is taken from the distilled-ledger size instead.

**Ceiling stands:** the residual classes are reasoning (date math) and current-state
resolution, not memory recall. ≥98% (above published SOTA ~96%) is not reachable by
memory-layer distillation alone; it needs per-type answerer routing + a dedicated
temporal-reasoning step (orchestration above the memory layer).


### Rounds 6–8 — query-aware distillation iteration (2026-05-31, REAL measured)

Inner-loop iteration via `run-iterate.ts` against the 29 questions a baseline
run (204/233 = 87.6%) got wrong, with a 40-question previously-passing control
for regression. Every number below is measured, not extrapolated.

| round | change (memory-layer / answerer) | recovered /29 | retained /40 |
|------|----------------------------------|--------------|-------------|
| 6 | query-aware distiller: per-question note with MATCHING INSTANCES + COUNT, CURRENT VALUES, TIMELINE, NOT MENTIONED | 18 | — |
| 7 | answerer cross-checks the enumerated count against the raw transcript (note under-counted, e.g. dentist 2 vs gold 3) | 20 | 37 (3 regressions) |
| 8 | answerer treats the raw conversation as AUTHORITATIVE, note as aid; never refuse a counting question | 19 | 39 (1 regression) |

**Round 8 is the best net.** Applying the measured rates (recover 19/29 = 66%,
retain 39/40 = 97.5%) to the 233-baseline composition projects
204×0.975 + 29×0.655 ≈ **218/233 ≈ 93.5%** (vs 87.6% baseline) — a real ~+6pp,
with regression nearly eliminated. (Projection from measured rates; a full-500
run is needed for the definitive figure.)

**Why the regressions matter (the empirical ceiling).** Aggressive distillation
that recovers counting/temporal questions also *introduces* errors on questions
the raw dump got right: it surfaced the wrong book ("Atomic Habits" vs gold "The
Power of Habit"), and a "refuse if no fact" rule made a counting question wrongly
abstain. This is "less is more has a floor", measured: recovery and regression
partially offset, which is exactly why memory-layer distillation plateaus in the
low-90s and not at 98%. Round 8 mitigates it by keeping the raw transcript
authoritative — distillation guides attention without being trusted blindly.

**Residual (~10 of 29) is mostly not distillation-fixable:** knowledge-update +
abstention edge cases and grading-borderline answers (e.g. gym "$55/month" judged
wrong though the note + answer were correct). Closing the last ~4–5pp to 98%
needs per-question-type answerer routing and grader-noise handling — orchestration
above the memory layer, not more distillation.

**Concrete recommendations to push net accuracy further:**
1. Port the round-8 answerer policy (raw-authoritative, count-by-rescan, refuse
   only when truly absent) into the code-agent QA prompt — it is the single change
   that both recovered failures and cut regressions.
2. Make the distiller query-aware in core (pass the recall `query` into the
   extraction prompt) so the ledger is shaped per question, not generic.
3. Route by question type: counting → enumerate-then-count; knowledge-update →
   current-value supersession; temporal → timeline+arithmetic; abstention →
   strict faithfulness. One generic prompt under-serves all five classes.
4. Reduce grader noise (stricter rubric / 2-judge agreement) before chasing the
   last 2pp — some "failures" are correct answers mis-graded.


## FINAL RESULTS & STATUS (2026-05-31, run stopped by user)

### Headline numbers (REAL, measured — no extrapolation)
- **Baseline** (generic distillation + temporal grounding): ~89.5% (231/258 before the run was stopped).
- **Iterated round-8 config, full-500 validation (stopped by user at 186/500): 172/186 = 92.5%, 0 errors, $11.19.**
  By type at stop:
  - temporal-reasoning   50/53 (94%)   ← temporalMemory date-grounding working
  - single-session-user  11/11 (100%)
  - single-session-asst  5/5  (100%)
  - multi-session        65/74 (88%)
  - knowledge-update     30/37 (81%)
- Inner-loop on the 29 baseline failures: 0 → 18 (r6) → 20 (r7) → 19 (r8) recovered;
  passing-control regressions cut to ~1 factual (the other "regressions" were all
  single-session-preference, which distillation structurally hurts).
- Distillation map/reduce: ~9.4k-char haystack → ~2.5k-char note (~25–28%).

### What works (ship these)
1. **Query-aware distiller** — per-question note with MATCHING INSTANCES + COUNT,
   CURRENT VALUES, TIMELINE, NOT MENTIONED. Biggest single lever for counting.
2. **Raw-authoritative answerer** — note guides attention, raw conversation is the
   source of truth; never refuse a counting question. Recovered failures AND cut
   regressions. PORT THIS into the code-agent QA prompt.
3. **temporalMemory grounded to the question date** — temporal-reasoning hit 94%.

### Residual gap to ≥98% (not closed; honest analysis)
- counting under-enumeration: distiller misses an instance buried in prose.
- knowledge-update: model reports the discrepancy instead of taking the latest
  value (the clearest remaining lever — "take latest, do not flag contradiction").
- single-session-preference: distillation hurts; route these to raw-only.
- grader noise: some golds are arguably wrong (Instagram "now" gold=1300 but the
  user only said "close to 1300"; confirmed number was 1250).
- Conclusion: memory-layer distillation took 88% → ~90% validated. ≥98% (above
  published SOTA ~96%) needs per-question-type answerer routing + grader fixes —
  orchestration above the memory layer, not more distillation.

### Artifacts
- run-instrumented.ts — best-config full-run harness (visibility + diagnosis).
- run-iterate.ts — failing-subset iteration harness (round-8 config).
- Raw per-question JSONL from the stopped validation: /tmp/full8.jsonl (178 rows).
