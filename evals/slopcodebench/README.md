# SlopCodeBench (`slopcodebench/`)

[SlopCodeBench](https://github.com/SprocketLab/slop-code-bench) (SCBench) is a
benchmark that evaluates coding agents under **iterative specification
refinement**: an agent implements a spec, then extends its own code as the spec
changes across checkpoints, exposing path-dependence and non-convergence that
single-shot benchmarks miss. Agents are graded with pytest.

This eval drives the real `@noetic-tools/code-agent` (`createCodeAgent()` — full
Noetic memory stack + coding tools) against SlopCodeBench problems and reports
the benchmark's own pass rate. Everything needed lives in this folder; the
benchmark itself is cloned on demand into a git-ignored `vendor/`.

## How it fits together

SlopCodeBench is a Python framework that orchestrates an agent inside an
execution environment, then grades the produced program. Agents plug in by
subclassing its `Agent` base class. We integrate without forking the benchmark:

```
run.ts ──uv run──▶ launch.py ──registers──▶ NoeticAgent (adapter.py)
                       │                          │ run(task)
                       ▼                          ▼  spawns
                  slop-code CLI            bun noetic-solve.ts ──▶ createCodeAgent()
                  (unmodified)                     (real Noetic code agent, act mode)
                       │                                   │ edits files
                       ▼                                   ▼
                 pytest grading  ◀────────────  workspace (local temp dir)
```

- **`launch.py`** imports `adapter.py` (which calls `register_agent("noetic", …)`)
  and then hands off to the unmodified `slop-code` Typer app. Because SCBench
  builds the agent from a raw config dict via its registry at run time, this
  registers the `noetic` agent type without patching the vendored source.
- **`adapter.py`** is the `NoeticAgent` SCBench adapter. On each checkpoint it
  shells out to the headless solver, then records token/cost usage.
- **`noetic-solve.ts`** is the headless Noetic code agent: it spins up
  `createCodeAgent()` with Node filesystem/shell adapters pointed at the
  workspace and drives the real product workflow, `codeAgentWorkflow`
  (plan/act/verify/fix), in forced **act** mode — the headless equivalent of an
  auto-approved plan — until the task is done, then prints a one-line usage
  result. The task is passed as the workflow input so it reaches the spawned
  act sub-agent. (Forcing act mode uses the `writeFlowState`/`persistFlowState`
  helpers `@noetic-tools/code-agent` exports for headless drivers.)

We target SCBench's **local** execution environment (`local-py`): there the
workspace is a host temp directory, so the host's `bun` and the in-repo
`@noetic-tools/code-agent` operate on it directly — no agent runtime is needed
inside a container. (Running under the Docker environment would require `bun` +
the built agent inside the image; that is out of scope.)

## Setup

```bash
# 1. Install workspace deps (from the repo root)
bun install

# 2. Clone SlopCodeBench into vendor/, uv sync, install our model + problems
bun evals/slopcodebench/setup.ts

# 3. Make sure an OpenRouter key is available
export OPENROUTER_API_KEY=sk-or-...
```

Prerequisites on PATH: `git`, [`uv`](https://astral.sh/uv) (Python 3.12+), and
`bun`. `setup.ts` pins the benchmark to a known-good commit (override with
`SCBENCH_REF=<sha>`).

## Run

```bash
# Smallest run: our self-contained `greeter` smoke problem (1 checkpoint)
bun evals/slopcodebench/run.ts

# Pick a problem / model / prompt
bun evals/slopcodebench/run.ts --problem greeter --model openrouter/sonnet-4.6
bun evals/slopcodebench/run.ts --problem greeter --prompt plan_first
```

`run.ts` auto-runs `setup.ts` if `vendor/` is missing, invokes the benchmark
(solve + pytest grading), and prints a per-checkpoint pass summary. The
benchmark's full artifacts land under `vendor/outputs/<model>/<run>/`
(`result.json`, `checkpoint_results.jsonl`, per-checkpoint `evaluation.json`).

### Result

End-to-end run of the `greeter` smoke problem:

| Date | Agent model | Problem | Checkpoints solved | Tests | Cost |
|------|-------------|---------|--------------------|-------|------|
| 2026-06-15 | `openrouter/claude-3.5-haiku` | `greeter` | 1/1 (100%) | 2/2 | $0.01 |

The agent is driven through the real `codeAgentWorkflow` (plan/act/verify/fix) in
forced act mode — see the solver header and the architecture notes above.

## Running the real benchmark problems

The official problem set lives in a separate repo (gabeorlanski/scb-problems)
and is large. Fetch it with the vendored CLI and point the runner at it:

```bash
cd evals/slopcodebench/vendor && uv run slop-code sync       # downloads ~/.cache/scbench
# then, from the repo root:
SCBENCH_PROBLEMS_PATH=~/.cache/scbench/problems \
  bun evals/slopcodebench/run.ts --problem <real-problem-name>
```

## Layout

| File | Purpose |
|------|---------|
| `setup.ts` | Clones + `uv sync` SlopCodeBench into `vendor/`, installs our model catalog + problems |
| `noetic-solve.ts` | Headless Noetic code agent (createCodeAgent, ReAct loop) — the "agent binary" SCBench drives |
| `adapter.py` | `NoeticAgent` SCBench `Agent` adapter (shells out to the solver, records usage) |
| `launch.py` | Registers `NoeticAgent`, then delegates to the unmodified `slop-code` CLI |
| `run.ts` | Standalone runner: ensures setup, runs the benchmark, prints a pass summary |
| `configs/noetic.yaml` | SCBench agent config (`type: noetic`) |
| `configs/models/*.yaml` | Model-catalog entries copied into the vendored catalog |
| `problems/greeter/` | Self-contained smoke problem (config + spec + pytest tests) |

## Knobs

| Flag / env | Default | Meaning |
|------------|---------|---------|
| `OPENROUTER_API_KEY` | — | Required for live runs |
| `--problem` | `greeter` | Problem name (resolved from `problems-local/` or `SCBENCH_PROBLEMS_PATH`) |
| `--model` | `openrouter/claude-3.5-haiku` | `provider/name`; resolved from SCBench's model catalog |
| `--prompt` | `just-solve` | SCBench prompt template (`just-solve`, `plan_first`, …) |
| `--environment` | `local-py` | SCBench execution environment |
| `SCBENCH_REF` | pinned commit | Benchmark commit to clone (setup) |
| `SCBENCH_PROBLEMS_PATH` | wired `problems-local/` | Problem catalog directory |

`vendor/`, `problems-local/`, and `outputs/` are git-ignored and regenerated by
`setup.ts`.

## Why our own `greeter` problem?

SlopCodeBench's bundled `examples/` are illustrative tutorials: their specs omit
the `%%%ENTRYPOINT:…%%%` placeholder (so the agent is never told the required
entry-file name) and their configs have drifted from the pinned schema. Shipping
a tiny, correct, version-controlled problem gives a deterministic, cheap,
always-green proof that the full pipeline works. Use `slop-code sync` for the
real, maintained problem set.
