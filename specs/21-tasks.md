# Tasks

> **Depends On:** `08-runtime` (`AgentHarness`, `FsAdapter`), `11-memory-layer-system` (steering layer slot conventions)
> **Exports:** `Task`, `LogEntry`, `Event`, `State`, `KanbanColumn`, `Milestone`, `Slice`, `Feature`, `Assertion`, `ValidatorRun`, `FixLineage`, `InterviewSession`, `runTasksCli`, `taskTools`, `createSteeringFileLayer`
> **Source of truth:** `packages/cli/src/commands/builtins/tasks/`
> **Docs:** `packages/web/content/docs/cli/tasks.mdx`

---

A **task** is the top-level unit of work in Noetic's CLI/TUI. It unifies what other systems call "tickets," "missions," and "worktree-backed reviews" under a single concept with a single identity scheme, a single CLI namespace, a single slash command, and a single agent-tool prefix.

The hierarchy that some tasks carry — milestones, slices, features, assertions, validator runs, fix lineage, interview sessions — is an internal implementation detail of "structured" tasks, not a parallel concept users learn separately.

## Conceptual model

A task has:

- **Identity.** `T-<10 chars>` — an immutable id (`packages/cli/src/commands/builtins/tasks/schemas.ts#TaskIdSchema`). All hierarchy entities use the same `<prefix>-<10 chars>` shape with prefixes `ML`, `SL`, `F`, `A`, `V`, `FX`, `IV`.
- **Source.** `'manual' | 'worktree'` — set at creation, immutable. Manual tasks are simple kanban cards. Worktree tasks were spawned by a worktree CLI flow and carry `worktreePath`, `branch`, `headSha`.
- **State axes.** Independent dimensions: `reviewStatus × lifecycleStatus × archivedAt × paused`. Kanban columns are derived from these axes; the on-disk record never stores the column directly.
- **Optional hierarchy.** A task gains a `hierarchy/` subdirectory when the user runs `noetic tasks plan <id>` (AI-driven interview), `noetic tasks add-milestone <id>`, or autonomously via the daemon's planner runner (autopilot plan-pass). Tasks without `hierarchy/` are leaves; tasks with `hierarchy/` are "structured." `hasHierarchy` is **derived** (`fs.exists(taskDir(id) + '/hierarchy/')`) — never stored, never persisted.
- **Optional autopilot.** Toggled with `noetic tasks autopilot <on|off> <id>`. When enabled, the daemon's autopilot tick orchestrates a three-phase pipeline:
  1. **plan-pass** — for tasks with no hierarchy yet, spawn the planner runner subprocess. The planner uses an LLM-driven `interview()` to produce a `TaskHierarchyInput` and persists it to `hierarchy/`.
  2. **implement-pass** — for triaged features whose linked leaf task has no worktree, spawn the implementer runner subprocess. The implementer provisions a worktree (`wt switch -c <branch>` with `git worktree add` fallback), drives a `react()` agent loop in the worktree, and flips the feature's `loopState` from `implementing` to `validating` on success or `blocked` on failure.
  3. **structured-tick** — for active hierarchies, advance slice/milestone state machines, dispatch `validatorRequestChan` events for `validating` features, and fire `mission:statusChanged` when `hierarchyStatus` transitions.
  The validator flow consumes `validatorRequestChan` and runs the `runValidator` built by `buildAdversarialValidatorStep()` (the default Step-graph validator: `agent-ci` and an LLM-driven adversarial code review forked in parallel — see "Validator runner" below). Each phase is independent; a manual task can be planned without autopilot ever firing the implement-pass, and structured tasks created by hand skip the plan-pass entirely.

A task may be both `worktree`-sourced and `structured`. All combinations of (source × hierarchy × autopilot) are valid.

## Storage layout

Single root: `<projectRoot>/.noetic/tasks/`. FS-only — no SQLite, no Drizzle. Path helpers live at `packages/cli/src/commands/builtins/tasks/paths.ts`.

```
<projectRoot>/.noetic/tasks/
├── _events.jsonl                    ← cross-process change feed
├── _state.json                      ← {schemaVersion, lastEventId}
└── T-<10 chars>/
    ├── task.json                    ← canonical task record (Zod-validated)
    ├── description.md               ← long-form description
    ├── log.jsonl                    ← append-only audit (kind=log|comment|steer|system)
    ├── steering.md                  ← optional, surfaced to in-task agent runs
    ├── _runner.json                 ← per-task agent-ci runner sidecar (pid + identity)
    ├── attachments/                 ← optional
    │   └── <verbatim filenames>
    └── hierarchy/                   ← present only for structured tasks
        ├── milestones/
        │   └── ML-<10 chars>.json
        ├── slices/
        │   └── SL-<10 chars>.json
        ├── features/
        │   └── F-<10 chars>/
        │       ├── feature.json
        │       ├── validator-runs/
        │       │   └── V-<10 chars>.json
        │       └── fix-lineage.jsonl
        ├── assertions/
        │   └── A-<10 chars>.json
        └── interview-sessions/
            └── IV-<10 chars>.json
```

## Atomicity guarantees

The store relies on three primitives, surfaced by `FsAdapter` (see `08-runtime`):

1. **Single-file mutables (`task.json`, `_state.json`, hierarchy JSONs, `_runner.json`).** Write-temp + atomic `rename`. Implemented by `atomicWrite` in `fs-store.ts` and `runner-state.ts`. The temp suffix carries random salt so concurrent writers do not collide.
2. **Append-only logs (`log.jsonl`, `_events.jsonl`, `fix-lineage.jsonl`).** `FsAdapter#appendFile`, backed by POSIX `O_APPEND`. Each log line is capped at `LOG_LINE_MAX_BYTES` (3 KiB) — sub-`PIPE_BUF` — so a single `write()` syscall publishes the entry atomically. Longer messages are split into chunked `LogEntry` records sharing a `ts`, `chunk`, and `chunkCount`.
3. **Multi-step writes are ordered audit → state → event.** Any change that touches multiple files publishes the audit log first (most conservative — never lies about intent), then the canonical state mutation (`task.json`), then the event in `_events.jsonl`. Within `appendEvent` the order is `_state.json` (bump `lastEventId`) → `_events.jsonl` append, so a tailer that reads up to `lastEventId` is guaranteed to find every event with `id <= lastEventId`.

Concurrency model: last-writer-wins on single-file mutables. The `O_APPEND` ceiling and 3 KiB log cap prevent interleaved log lines.

## Top-level Task schema

```typescript
type TaskSource = 'manual' | 'worktree';
type TaskReviewStatus = 'not_started' | 'reviewing' | 'needs_changes' | 'approved';
type TaskLifecycleStatus = 'active' | 'merged' | 'cleanup-blocked' | 'removed';
type HierarchyStatus = 'planning' | 'active' | 'blocked' | 'complete' | 'archived';
type AutopilotState = 'inactive' | 'planning' | 'watching' | 'activating' | 'completing';

interface Task {
  id: string;                                      // 'T-' + 10 chars
  source: TaskSource;
  title: string;
  projectRoot: string;

  // Worktree (null when not attached)
  worktreePath: string | null;
  branch: string | null;
  headSha: string | null;

  // Lifecycle / review state
  reviewStatus: TaskReviewStatus;
  lifecycleStatus: TaskLifecycleStatus;
  paused: boolean;
  archivedAt: string | null;                       // ISO-8601 or null

  // Strategic state (only meaningful when hierarchy/ exists)
  hierarchyStatus: HierarchyStatus | null;
  autopilotEnabled: boolean;
  autopilotState: AutopilotState;
  lastAutopilotActivityAt: string | null;

  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}
```

Source: `packages/cli/src/commands/builtins/tasks/schemas.ts#TaskSchema`.

## Hierarchy entity schemas

All hierarchy entities live under `<taskDir>/hierarchy/`. Every entity carries a Zod-validated id matching `^<prefix>-[A-Za-z0-9_-]{10}$`. Source: `packages/cli/src/commands/builtins/tasks/hierarchy/schemas.ts`.

```typescript
type MilestoneStatus = 'pending' | 'active' | 'complete' | 'blocked';
type SliceStatus = 'pending' | 'active' | 'complete' | 'blocked';
type FeatureStatus = 'defined' | 'triaged' | 'done' | 'blocked';
type FeatureLoopState =
  | 'idle' | 'implementing' | 'validating' | 'passed' | 'needs_fix' | 'blocked';
type AssertionStatus = 'pending' | 'passed' | 'failed' | 'blocked';
type ValidatorRunStatus = 'pending' | 'running' | 'pass' | 'fail' | 'blocked' | 'error';
type InterviewSessionStatus = 'active' | 'complete' | 'cancelled';

interface Milestone {
  id: string;                                      // 'ML-...'
  taskId: string;
  title: string;
  description: string | null;
  verification: string;
  status: MilestoneStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

interface Slice {
  id: string;                                      // 'SL-...'
  milestoneId: string;
  title: string;
  description: string | null;
  verification: string;
  status: SliceStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

interface Feature {
  id: string;                                      // 'F-...'
  sliceId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string;
  status: FeatureStatus;
  loopState: FeatureLoopState;
  implementationAttemptCount: number;
  validatorAttemptCount: number;
  taskId: string | null;                           // linked leaf task once triaged
  generatedFromFeatureId: string | null;           // 'F-...' if this is a fix
  generatedFromRunId: string | null;               // 'V-...' that triggered the fix
  blockedReason: string | null;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

interface Assertion {
  id: string;                                      // 'A-...'
  milestoneId: string;
  title: string;
  assertion: string;
  status: AssertionStatus;
  orderIndex: number;
  featureIds: string[];                            // 'F-...' covered by this assertion
  createdAt: string;
  updatedAt: string;
}

interface ValidatorRun {
  id: string;                                      // 'V-...'
  featureId: string;                               // 'F-...'
  startedAt: string;
  completedAt: string | null;
  status: ValidatorRunStatus;
  result: Record<string, unknown> | null;          // free-form/raw blob
  assertionOutcomes: AssertionOutcome[];           // structured per-assertion verdicts
  pid: number | null;
  pidStarttime: string | null;
  pausedAt: string | null;
}

interface AssertionOutcome {
  assertionId: string;                             // 'A-...'
  status: AssertionStatus;                         // pending | passed | failed | blocked
  message?: string;
}

interface FixLineage {
  id: string;                                      // 'FX-...'
  sourceFeatureId: string;
  fixFeatureId: string;
  validatorRunId: string;
  failedAssertionIds: string[];                    // 'A-...' from the run; empty if granular outcomes weren't reported
  createdAt: string;
}

interface InterviewSession {
  id: string;                                      // 'IV-...'
  taskId: string;
  status: InterviewSessionStatus;
  state: Record<string, unknown>;                  // partial plan + Q&A pairs
  createdAt: string;
  updatedAt: string;
}
```

Validator runs are mutable through the `pending → running → pass|fail|blocked|error` arc, written via temp+rename. Fix lineage is append-only (`fix-lineage.jsonl`, one line per `FixLineage`).

## LogEntry, Event, State schemas

Source: `packages/cli/src/commands/builtins/tasks/schemas.ts`.

```typescript
type LogEntryKind = 'log' | 'comment' | 'steer' | 'system';

interface LogEntry {
  kind: LogEntryKind;
  ts: string;                                      // ISO-8601
  message: string;
  chunk?: number;                                  // 1-based when split
  chunkCount?: number;
  meta?: Record<string, unknown>;
}

type EventKind =
  | 'task:created' | 'task:updated' | 'task:moved' | 'task:archived'
  | 'task:reviewStatusChanged' | 'session:finished' | 'log:appended'
  | 'milestone:created' | 'slice:created' | 'feature:created' | 'assertion:created'
  | 'feature:loopStateChanged' | 'feature:linkedToTask'
  | 'feature:fixGenerated' | 'feature:budgetExhausted'
  | 'validator:runRecorded' | 'mission:statusChanged';

interface Event {
  id: number;                                      // monotonic, from _state.json#lastEventId
  taskId: string | null;
  kind: EventKind;
  payload?: Record<string, unknown>;
  ts: string;
}

interface State {
  schemaVersion: number;                           // 1 today
  lastEventId: number;
}
```

The `mission:statusChanged` kind name is preserved verbatim for historical-tail compatibility. Externally the event surfaces a hierarchy-status change on a structured task.

## Kanban column derivation

`KanbanColumn = 'triage' | 'in_progress' | 'needs_changes' | 'ready_to_merge' | 'done' | 'cleanup_blocked' | 'removed' | 'archived'`. Derivation lives at `packages/cli/src/commands/builtins/tasks/kanban.ts#deriveColumn`. Source is **not** part of the column matrix — it is a card badge, not a column.

| Precedence | Condition | Column |
|---|---|---|
| 1 | `archivedAt !== null` | `archived` |
| 2 | `lifecycleStatus === 'merged'` | `done` |
| 3 | `lifecycleStatus === 'cleanup-blocked'` | `cleanup_blocked` |
| 4 | `lifecycleStatus === 'removed'` | `removed` |
| 5 | `reviewStatus === 'not_started'` (active lifecycle) | `triage` |
| 5 | `reviewStatus === 'reviewing'` (active lifecycle) | `in_progress` |
| 5 | `reviewStatus === 'needs_changes'` (active lifecycle) | `needs_changes` |
| 5 | `reviewStatus === 'approved'` (active lifecycle) | `ready_to_merge` |

`moveTask(ctx, { taskId, column })` computes the inverse — the minimum patch across `archivedAt / lifecycleStatus / reviewStatus` that lands the task in the target column. Moving to `archived` sets `archivedAt` to "now" if the task was not already archived. Moving to `done` flips `lifecycleStatus` to `'merged'`. Moving to a review-status column clears `archivedAt` and `lifecycleStatus` back to `'active'`, then sets the appropriate `reviewStatus`.

## Cross-process change feed

`_events.jsonl` is the durable event feed; in-process subscribers also receive events through an `EventEmitter` defined in `packages/cli/src/commands/builtins/tasks/events.ts`.

Tail semantics:

- A reader records a watermark `sinceId` (initially 0).
- `tailEvents(ctx, sinceId)` reads `_events.jsonl`, filters by `id > sinceId`, returns the suffix in order.
- Readers update their watermark to the highest observed `id`.
- `_state.json#lastEventId` is the upper bound — any event with `id <= lastEventId` is durably appended to `_events.jsonl`.
- Readers may use `fs.stat` size as a 1 Hz polling watermark to avoid re-parsing the whole file on every poll. The TUI tails only while the kanban is the active view-mode (`viewMode === 'taskBoard'`).

Rollover: when `_events.jsonl` exceeds 10 MiB the file is renamed to `_events.jsonl.<n>.bak` and a fresh `_events.jsonl` starts; tailers handle the rollover by re-opening on size decrease.

## agent-ci runner contract

The agent-ci runner reviews a task's worktree by running a workflow under `npx @redwoodjs/agent-ci`. Lifecycle:

1. **Launcher** (`packages/cli/src/commands/builtins/tasks/agent-ci-launcher.ts`) refuses to start if a live runner is already attached (verified pid + matching `pidStarttime`), spawns the runner script with the env contract below, captures `Signaller.startTime`, and atomically writes `_runner.json`. It then patches `task.json#reviewStatus` to `'reviewing'` (for non-terminal tasks) and emits a `task:reviewStatusChanged` event.
2. **Runner** (`packages/cli/src/commands/builtins/tasks/agent-ci-runner.ts`) is a `bun run`-invoked wrapper script. It spawns `npx @redwoodjs/agent-ci run --workflow <wf>` with stdio inherited (so the user sees the same output they would get running it by hand), waits for exit, and commits writes in the order **audit → state → event**:
   1. Append a `kind='system'` log entry (`agent-ci exited with code <n>`).
   2. Atomically rewrite `task.json` flipping `reviewStatus` according to the exit code (see table below) and clearing `paused`.
   3. Append a `task:reviewStatusChanged` event to `_events.jsonl` and fan out on the in-process bus.
   4. Best-effort: clear `_runner.json`.
3. **Control surfaces** (`agent-ci-control.ts`) read `_runner.json` to locate the live process for pause/unpause/cancel. Pid reuse is detected by re-reading `pidStarttime` before each signal.

### Env contract

The launcher passes these to the runner child:

| Var | Required | Meaning |
|---|---|---|
| `NOETIC_TASK_DIR` | yes | Absolute path to `<projectRoot>/.noetic/tasks/<taskId>`. Used by the runner to derive `taskId` and `projectRoot`, and by the steering memory layer to locate `steering.md`. |
| `NOETIC_TASK_WORKFLOW` | yes | Workflow file passed to `agent-ci run --workflow`. |
| `NOETIC_TASK_CWD` | no | Working dir for the agent-ci child. Defaults to `process.cwd()`. |

### Exit code → reviewStatus mapping

| Exit code | Resulting `reviewStatus` |
|---|---|
| `0` | `approved` |
| anything else (incl. signal-killed, `null`) | `needs_changes` |

### Sidecar `_runner.json`

Volatile process state lives in a sidecar so the canonical `task.json` never carries pid bits. Schema (`packages/cli/src/commands/builtins/tasks/runner-state.ts#RunnerStateSchema`):

```typescript
interface RunnerState {
  taskId: string;                                  // 'T-...'
  sessionId: string;                               // launcher-assigned
  pid: number;
  pidStarttime: string | null;                     // ps -o lstart= snapshot
  workflow: string;
  startedAt: string;
  pausedAt: string | null;
}
```

The launcher creates it; the runner clears it on exit; control surfaces read it. Stale entries are evicted by the launcher's pre-spawn pid check.

## Planner runner contract

The planner runner produces a task hierarchy autonomously for a manual task that has been opted into autopilot but has no `hierarchy/` subtree yet. Lifecycle:

1. **Launcher** (`packages/cli/src/commands/builtins/tasks/planner-launcher.ts`) refuses to start if a live planner is already attached, spawns `bun run planner-runner.ts` as a detached child with the env contract below, persists `_planner.json`, then atomically flips `task.json#autopilotState` to `'planning'` and emits a `task:updated{phase: 'spawn'}` event.
2. **Runner** (`packages/cli/src/commands/builtins/tasks/planner-runner.ts`) is a `bun run`-invoked wrapper. It constructs a minimal `AgentHarness`, drives the `interview()` pattern (`@noetic/core`) with an LLM-backed `askQuestion` responder (`llm-interview-responder.ts`) so the model interviews itself using only the task title + `description.md` as context. On completion the runner commits in **audit → state → event** order:
   1. Append a `kind='system'` log entry summarising the outcome.
   2. Persist the resulting hierarchy via `persistTaskHierarchy()` and atomically rewrite `task.json` with `hierarchyStatus: 'active'` + `autopilotState: 'watching'`.
   3. Append a `mission:statusChanged` event.
   4. Best-effort: clear `_planner.json`.

   On `failed` / `maxQuestions` outcomes the runner flips `autopilotState` back to `'inactive'` and emits a `task:updated{phase: 'exit'}` event.
3. **Refusal to overwrite.** Even if a stale launcher races a new spawn, the runner re-checks `getTaskHierarchy` and refuses to plan a task whose hierarchy already has milestones.

### Env contract

| Var | Required | Meaning |
|---|---|---|
| `NOETIC_TASK_DIR` | yes | Absolute path to `<projectRoot>/.noetic/tasks/<taskId>`. The runner derives `taskId` and `projectRoot`. |
| `NOETIC_TASK_CWD` | no | Working dir for the AgentHarness. Defaults to `process.cwd()`. |
| `NOETIC_MODEL` | no | LLM identifier. Defaults to `anthropic/claude-sonnet-4`. |
| `OPENROUTER_API_KEY` | yes (production) | OpenRouter key for the LLM provider. |

### Sidecar `_planner.json`

Schema (`packages/cli/src/commands/builtins/tasks/planner-state.ts#PlannerStateSchema`):

```typescript
interface PlannerState {
  taskId: string;                                  // 'T-...'
  sessionId: string;
  pid: number;
  pidStarttime: string | null;
  startedAt: string;
  pausedAt: string | null;
}
```

## Implementer runner contract

The implementer runner builds one feature inside its own git worktree. The autopilot's implement-pass spawns one implementer per triaged feature whose linked leaf task has no `worktreePath` yet. Lifecycle:

1. **Launcher** (`packages/cli/src/commands/builtins/tasks/implementer-launcher.ts`) refuses to start if a live implementer is already attached, calls `provisionWorktree` (tries `wt switch -c <branch>`, falls back to `git worktree add <projectRoot>/.worktrees/<branch> -b <branch>`), spawns `bun run implementer-runner.ts` with the env contract below, then in **audit→state→event** order persists `_implementer.json`, atomically patches the leaf task's `worktreePath` + `branch`, emits `task:updated`, and finally emits `feature:loopStateChanged{phase: 'spawn', loopState: 'implementing'}`.
2. **Runner** (`packages/cli/src/commands/builtins/tasks/implementer-runner.ts`) constructs a full coding-tools `AgentHarness` rooted at the worktree, loads the parent's hierarchy, builds a prompt from the feature's `acceptanceCriteria` + the parent milestone's assertions, and drives a `react()` agent loop bounded by `DEFAULT_IMPLEMENTATION_RETRY_BUDGET`. On success it commits **audit→state→event**:
   1. Append a `kind='system'` log entry on the leaf task.
   2. Atomically flip the parent feature's `loopState` from `implementing` to `validating` (or `blocked` on failure / max-steps) via `applyFeatureLoopStateUpdate`.
   3. Append a `feature:loopStateChanged{phase: 'exit'}` event on the parent task.
   4. Best-effort: clear `_implementer.json`.

### Env contract

| Var | Required | Meaning |
|---|---|---|
| `NOETIC_TASK_DIR` | yes | Absolute path to the **leaf** task dir. Used to derive the leaf `taskId` and the project root. |
| `NOETIC_PARENT_TASK_ID` | yes | Structured task that owns the feature. The runner mutates the feature on this task's hierarchy. |
| `NOETIC_FEATURE_ID` | yes | Feature inside the parent's hierarchy. |
| `NOETIC_TASK_CWD` | yes | The worktree path. The harness runs all coding tools rooted here. |
| `NOETIC_MODEL` | no | LLM identifier. Defaults to `anthropic/claude-sonnet-4`. |
| `OPENROUTER_API_KEY` | yes (production) | OpenRouter key for the LLM provider. |

### Sidecar `_implementer.json`

Schema (`packages/cli/src/commands/builtins/tasks/implementer-state.ts#ImplementerStateSchema`):

```typescript
interface ImplementerState {
  taskId: string;                                  // 'T-...' (leaf task)
  parentTaskId: string;                            // 'T-...' (structured parent)
  featureId: string;                               // 'F-...'
  sessionId: string;
  pid: number;
  pidStarttime: string | null;
  worktreePath: string;
  branch: string;
  startedAt: string;
  pausedAt: string | null;
}
```

## Validator runner

The daemon's validator dispatches `validatorRequestChan` items to `runValidator: RunValidatorFn`. The default production binding is `buildAdversarialValidatorStep()` from `adversarial-validator-flow.ts`, run via `harness.run(flow, args, ctx)`. The flow is a Step graph: a single `step.run` resolves the leaf task's worktree, then dispatches a `fork({mode: 'all'})` over two paths that run in parallel:

| Path | Step kind | Behaviour |
|---|---|---|
| `validator.agent-ci` | `step.run` wrapping a subprocess spawn | Runs `npx @redwoodjs/agent-ci run --quiet` in the worktree. Exit 0 → partial `pass`; non-zero → partial `fail`; missing binary → partial `pass` with `missing: true` (skip-on-missing default). |
| `validator.adversarial-review` | `step.llm({output: AdversarialIssuesSchema})` | Reads `git diff main...HEAD` and re-emits a structured list of issues against the feature's acceptance criteria + assertions. Empty issue list → partial `pass`; any issues → partial `fail`. |

The fork's `merge` reconciles both partials into a single `ValidatorRunOutcome`:

- agent-ci `error` → outcome `error` (adversarial result discarded).
- agent-ci `fail` OR adversarial issues found → outcome `fail`. The adversarial reviewer's per-assertion findings populate `assertionOutcomes` so the fix-feature flow has structured failure data, not just free text.
- Both pass → outcome `pass` with all assertions reported as `passed`.

The validator returns `error` immediately when the leaf task has no `worktreePath` (i.e. the implementer hasn't run yet) so the daemon never observes a hung validation. Projects that don't want adversarial review can pass `runValidator` directly to `buildHierarchyDaemonHarness` to short-circuit the default wiring.

## Steering memory layer

`createSteeringFileLayer()` (`packages/cli/src/memory/steering-file-layer.ts`) surfaces `<NOETIC_TASK_DIR>/steering.md` to a task's agent run.

Contract:

- **Slot.** `Slot.STEERING` (90), placing it ahead of working memory so steering nudges shape interpretation of every downstream block.
- **Activation.** Conditional on `process.env.NOETIC_TASK_DIR`. When unset, `recall()` returns `null` and the layer is dormant — non-task agent runs never see steering content.
- **Missing file.** ENOENT on `steering.md` is treated as "no steering content" (returns `null`), so half-populated task directories degrade gracefully.
- **Output shape.** When a non-empty `steering.md` exists, `recall()` emits a developer-role block prefixed with `# Task Steering`.

The layer is mounted unconditionally by `harness/factory.ts`; gating on the env var is what scopes its effect to in-task runs.

## CLI verbs

Single dispatcher: `noetic tasks <verb>`. Source: `packages/cli/src/commands/builtins/tasks/cli.ts`. Each verb is a thin wrapper around its handler in `packages/cli/src/commands/builtins/tasks/handlers/`.

| Verb | Summary |
|---|---|
| `create` | Create a manual task (`--title`, optional `--description`). |
| `show` | Print a task with recent log + hierarchy summary (`--tail n`). |
| `list` | List tasks. Filter with `--column` / `--source`. Terminal columns (`removed`, `cleanup_blocked`, `archived`) are hidden by default to match the kanban TUI; `--terminal` reveals `removed` / `cleanup_blocked`, and `--all` additionally reveals archived. An explicit `--column <hidden>` always shows that column. |
| `move` | Move a task to another kanban column (`--column`). |
| `merge` | Merge the task branch via `wt merge`; falls back to `git merge`. |
| `log` | Append a `kind='log'` entry. |
| `logs` | Tail the `--n` most recent log entries. |
| `attach` | Copy a file into `<taskDir>/attachments/`. |
| `comment` | Append a `kind='comment'` log entry. |
| `steer` | Append a `kind='steer'` entry and write/append `steering.md`. |
| `pause` | Pause the active agent-ci runner. |
| `unpause` | Resume a paused runner. |
| `archive` | Set `archivedAt` to now. |
| `unarchive` | Clear `archivedAt`. |
| `delete` | Hard-delete the task directory; emits `task:deleted`. Refused while a live agent-ci runner sidecar is attached or a validator run is running; pass `--force` to override. |
| `duplicate` | Copy `task.json` + `description.md` + `attachments/` under a new id. |
| `plan` | Run the live AI-driven interview to build a hierarchy. TUI-only — the headless CLI surfaces a "use the TUI" error. |
| `add-milestone` | Append a milestone (`--title`, `--verification`). |
| `add-slice` | Append a slice under a milestone (`--milestone`, `--title`, `--verification`). |
| `add-feature` | Append a feature under a slice (`--slice`, `--title`, `--acceptance`). |
| `add-assertion` | Append an assertion under a milestone (`--milestone`, `--title`, `--assertion`, `--features`). |
| `activate-slice` | Mark a slice `active` and (optionally) triage its features into leaf tasks. |
| `autopilot` | Toggle the autopilot flag for a structured task (`<on|off>`). |

Unknown verbs and `--help` print the verb table to stdout; unknown verbs exit 1, `--help` exits 0.

## Agent tools

The `task_*` tool prefix mirrors the CLI verb table 1:1 (excluding `--help`). Tools are registered by `harness/factory.ts` via a `taskTools(opts)` factory and are default-on; opt out via `tools.tasks: false` in `noetic.config.ts`.

| Tool | CLI parity |
|---|---|
| `task_create` | `create` |
| `task_show` | `show` |
| `task_list` | `list` |
| `task_move` | `move` |
| `task_merge` | `merge` |
| `task_log` | `log` |
| `task_logs` | `logs` |
| `task_attach` | `attach` |
| `task_comment` | `comment` |
| `task_steer` | `steer` |
| `task_pause` | `pause` |
| `task_unpause` | `unpause` |
| `task_archive` | `archive` |
| `task_unarchive` | `unarchive` |
| `task_delete` | `delete` |
| `task_duplicate` | `duplicate` |
| `task_plan` | `plan` |
| `task_add_milestone` | `add-milestone` |
| `task_add_slice` | `add-slice` |
| `task_add_feature` | `add-feature` |
| `task_add_assertion` | `add-assertion` |
| `task_activate_slice` | `activate-slice` |
| `task_autopilot` | `autopilot` |

23 tools total. Each delegates to the same handler the CLI verb uses, so behaviour is identical across surfaces.

A read-only variant `taskTools({ readOnly: true })` exposes only `task_show`, `task_list`, `task_logs` — safe to register in sandboxes that should not mutate task state.

## Slash command

`/tasks` (`packages/cli/src/commands/builtins/tasks/index.tsx`) flips the TUI's `viewMode` to `'taskBoard'`. The command itself returns `{ type: 'skip' }` so nothing is appended to the chat transcript.

There is no `/mission` command. There is no alias.

## TUI behaviour

When `viewMode === 'taskBoard'`, `app.tsx` renders the kanban board instead of the chat. UI components live under `packages/cli/src/commands/builtins/tasks/ui/`:

- **`task-board.tsx`** — full-screen kanban across all eight columns. Cards from every task source are interleaved, each with a `[m]` (manual) or `[w]` (worktree) source badge. Structured tasks (those with `hierarchy/`) display a `▾` glyph inline.
- **`task-card.tsx`** — single-card render shared between board and detail.
- **`task-detail.tsx`** — leaf-task drill-in: description, log tail, attachments.
- **`task-hierarchy-view.tsx`** — drill-in for structured tasks: milestones → slices → features tree, with assertions and validator runs in side panels.
- **`task-create-form.tsx`** — opened by `c`. Title + description; submits to `task_create`.
- **`task-move-picker.tsx`** — opened by `m` on a focused card. Lists kanban columns; submits to `task_move`.
- **`interview-panel.tsx`** — AI-driven planning UI invoked by `noetic tasks plan` from the TUI. Renders questions through the harness's `AskUserService`, persists the partial plan into `interview-sessions/IV-<id>.json`, and on completion writes the full hierarchy via `persistTaskHierarchy`.
- **`use-events-tail.ts`** — React hook that polls `_events.jsonl` (1 Hz `fs.stat` watermark) while `viewMode === 'taskBoard'`. Returns the suffix of events since the last render and updates the watermark.

`Enter` on a focused card navigates: structured → hierarchy view; leaf → detail. `Escape` from any drill-in returns to the board.

## Cross-references

- `08-runtime` — `FsAdapter`, `AgentHarness` lifecycle.
- `11-memory-layer-system` / `12-builtin-memory-layers` — slot conventions for the steering layer.
- `09-error-model` — handlers throw plain `Error` (not `NoeticError`); see `handlers/_shared.ts#formatError`.

## Future Considerations

- **Cross-task dependencies.** Today every task is independent of every other. A future `dependsOn: string[]` field on `Task` could express ordering constraints; the kanban could surface blocked-on-other tasks differently from blocked-on-cleanup.
- **Multi-machine sync.** `.noetic/tasks/` is currently single-machine. A future sync layer (git-tracked plus a CRDT for `_events.jsonl`) would let teams share a kanban. Nothing in the schema today precludes this.
- **flock on canonical mutables.** Concurrent writers on the same `task.json` / `feature.json` are last-writer-wins. If real contention appears in practice, an advisory `flock` around the temp+rename window would close the window without changing the schema.
- **Event archive compaction.** `_events.jsonl.<n>.bak` rollovers are never compacted. A periodic compaction pass that drops events older than the oldest live `lastSeenAt` would bound disk usage on long-running projects.
