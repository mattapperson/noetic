## @noetic-tools/core-v5.22.0-next.21 (2026-11-27)

* Recover interrupted durable workflows (#186) ([5aba218](https://github.com/mattapperson/noetic/commit/5aba218)), closes [#186](https://github.com/mattapperson/noetic/issues/186)

## @noetic-tools/core-v5.22.0-next.20 (2026-11-27)

* feat: say in a JSON workflow document everything a TypeScript workflow can (#185) ([d448249](https://github.com/mattapperson/noetic/commit/d448249)), closes [#185](https://github.com/mattapperson/noetic/issues/185) [#184](https://github.com/mattapperson/noetic/issues/184) [#182](https://github.com/mattapperson/noetic/issues/182) [#184](https://github.com/mattapperson/noetic/issues/184) [#184](https://github.com/mattapperson/noetic/issues/184)

## @noetic-tools/core-v5.22.0-next.19 (2026-11-26)

* feat(core): store a JSON workflow with each turn and resume on it (#184) ([3a8b17a](https://github.com/mattapperson/noetic/commit/3a8b17a)), closes [#184](https://github.com/mattapperson/noetic/issues/184)

## @noetic-tools/core-v5.22.0-next.18 (2026-11-26)

* feat!: one subprocess adapter concept, and named fs, shell and subprocess adapters (#182) ([096c64d](https://github.com/mattapperson/noetic/commit/096c64d)), closes [#182](https://github.com/mattapperson/noetic/issues/182)

## @noetic-tools/core-v5.22.0-next.17 (2026-11-26)

* Run Cloudflare cron work on durable Noetic harnesses (#183) ([0e97b35](https://github.com/mattapperson/noetic/commit/0e97b35)), closes [#183](https://github.com/mattapperson/noetic/issues/183)

## @noetic-tools/core-v5.22.0-next.16 (2026-11-26)

* feat(core): stream context windows from the harness (#181) ([1695950](https://github.com/mattapperson/noetic/commit/1695950)), closes [#181](https://github.com/mattapperson/noetic/issues/181)

## @noetic-tools/core-v5.22.0-next.15 (2026-11-26)

* feat(core): retry held answers, report what still fails, take typed answers (#178) ([20f4a4b](https://github.com/mattapperson/noetic/commit/20f4a4b)), closes [#178](https://github.com/mattapperson/noetic/issues/178)

## @noetic-tools/core-v5.22.0-next.14 (2026-11-26)

* Refactor harness turns and model execution (#177) ([0f0ea34](https://github.com/mattapperson/noetic/commit/0f0ea34)), closes [#177](https://github.com/mattapperson/noetic/issues/177)

## @noetic-tools/core-v5.22.0-next.13 (2026-11-26)

* feat(acp): what a host that starts its own agents reads from noetic (#174) ([e21dfed](https://github.com/mattapperson/noetic/commit/e21dfed)), closes [#174](https://github.com/mattapperson/noetic/issues/174) [#171](https://github.com/mattapperson/noetic/issues/171)

## @noetic-tools/core-v5.22.0-next.12 (2026-11-26)

* feat: an agent's tool calls, plans and settings reach the host in one vocabulary (#172) ([cf712bf](https://github.com/mattapperson/noetic/commit/cf712bf)), closes [#172](https://github.com/mattapperson/noetic/issues/172) [#170](https://github.com/mattapperson/noetic/issues/170)

## @noetic-tools/core-v5.22.0-next.11 (2026-11-25)

* feat: support video input in user messages (#173) ([9cd2683](https://github.com/mattapperson/noetic/commit/9cd2683)), closes [#173](https://github.com/mattapperson/noetic/issues/173)

## @noetic-tools/core-v5.22.0-next.10 (2026-11-25)

* feat: an agent step's turn reaches the host as a model call's does (#171) ([196b1e1](https://github.com/mattapperson/noetic/commit/196b1e1)), closes [#171](https://github.com/mattapperson/noetic/issues/171) [#169](https://github.com/mattapperson/noetic/issues/169)

## @noetic-tools/core-v5.22.0-next.9 (2026-11-25)

* feat: an agent step's subagents are nested agents on the ordinary event stream (#170) ([31dd1b9](https://github.com/mattapperson/noetic/commit/31dd1b9)), closes [#170](https://github.com/mattapperson/noetic/issues/170) [#169](https://github.com/mattapperson/noetic/issues/169)

## @noetic-tools/core-v5.22.0-next.8 (2026-11-25)

* fix: preserve queued events and clean up displaced spills ([f72b5f4](https://github.com/mattapperson/noetic/commit/f72b5f4))

## @noetic-tools/core-v5.22.0-next.7 (2026-11-25)

* feat: an agent step meets the host only through generic concepts (instructions, held questions, Noet ([858cdca](https://github.com/mattapperson/noetic/commit/858cdca)), closes [#169](https://github.com/mattapperson/noetic/issues/169)

### BREAKING CHANGE

* An ACP step's host-facing surface is generic.
`instructions` replaces `systemPrompt`, vendor `_meta` moves to the
adapter (`sessionMeta`), and the step options `onElicitation` /
`onSubagentUpdate` are gone: an agent's questions are held calls with
`reason: 'question'` (MCP `input_required` too), offered by default.
`HeldCall.reason` gains `'question'`. ACP steps throw
`NoeticConfigError` `AGENT_CAPABILITY_MISSING` or `NoeticError`
`step_failed`, never `AcpCapabilityError` / `AcpConnectError`.
`AcpAgentConnection` requires `fingerprintFor`;
`AcpBoundElicitationHandler` takes `AcpElicitationInfo`;
`AcpConnectError` has `gone`. A resume or reattach starts over only when
the agent is confirmed gone; any other failure fails the step.

Signed-off-by: Matt <me@mattapperson.com>

## @noetic-tools/core-v5.22.0-next.6 (2026-11-25)

* chore(core): release 5.22.0-next.6 [skip ci] ([33eb330](https://github.com/mattapperson/noetic/commit/33eb330))
* feat(core): resume a stored turn without its kept steers; harness.getStoredThread (#168) ([1ea3a24](https://github.com/mattapperson/noetic/commit/1ea3a24)), closes [#168](https://github.com/mattapperson/noetic/issues/168)

## @noetic-tools/core-v5.22.0-next.6 (2026-11-25)

* feat(core): resume a stored turn without its kept steers; harness.getStoredThread (#168) ([1ea3a24](https://github.com/mattapperson/noetic/commit/1ea3a24)), closes [#168](https://github.com/mattapperson/noetic/issues/168)

## @noetic-tools/core-v5.22.0-next.5 (2026-11-25)

* feat(acp): native host support for #96–#100, agents that outlive their host, and reattach (#167) ([3953c32](https://github.com/mattapperson/noetic/commit/3953c32)), closes [#100](https://github.com/mattapperson/noetic/issues/100) [#167](https://github.com/mattapperson/noetic/issues/167) [#156](https://github.com/mattapperson/noetic/issues/156)

## @noetic-tools/core-v5.22.0-next.4 (2026-11-25)

* feat: Durable Object hosting — cut turns, turnOptions, per-turn tools, shared alarm (#166) ([2a3a0cd](https://github.com/mattapperson/noetic/commit/2a3a0cd)), closes [#166](https://github.com/mattapperson/noetic/issues/166)

## @noetic-tools/core-v5.22.0-next.3 (2026-11-25)

* fix(core): native support for spec-workspace host workarounds (#140, #142, #143, #95) (#165) ([b1f58ca](https://github.com/mattapperson/noetic/commit/b1f58ca)), closes [#140](https://github.com/mattapperson/noetic/issues/140) [#142](https://github.com/mattapperson/noetic/issues/142) [#143](https://github.com/mattapperson/noetic/issues/143) [#95](https://github.com/mattapperson/noetic/issues/95) [#165](https://github.com/mattapperson/noetic/issues/165) [#161](https://github.com/mattapperson/noetic/issues/161)
* feat(core): forget a thread or an execution, and list what is stored (#163) ([b025b02](https://github.com/mattapperson/noetic/commit/b025b02)), closes [#163](https://github.com/mattapperson/noetic/issues/163)
* feat(core): onHeld, steerWhileHeld and tool_call_settled for held tool calls (#164) ([13fa817](https://github.com/mattapperson/noetic/commit/13fa817)), closes [#164](https://github.com/mattapperson/noetic/issues/164)

## @noetic-tools/core-v5.22.0-next.2 (2026-11-25)

* feat(core): land the spec-workspace patch: decide headers and base URL, Tool.toModelOutput, interact ([7b21be0](https://github.com/mattapperson/noetic/commit/7b21be0)), closes [#161](https://github.com/mattapperson/noetic/issues/161) [#159](https://github.com/mattapperson/noetic/issues/159) [#159](https://github.com/mattapperson/noetic/issues/159) [#159](https://github.com/mattapperson/noetic/issues/159) [#120](https://github.com/mattapperson/noetic/issues/120) [#160](https://github.com/mattapperson/noetic/issues/160)
* feat(platform-cloudflare-worker): storage scopes and spill for large values; unblock the release cha ([63d0a30](https://github.com/mattapperson/noetic/commit/63d0a30)), closes [#162](https://github.com/mattapperson/noetic/issues/162)

## @noetic-tools/core-v5.22.0-next.1 (2026-11-25)

* fix(chat-sdk): a parked turn's reply finishes, and a lost click is not reported delivered ([e498c5e](https://github.com/mattapperson/noetic/commit/e498c5e))
* fix(core): a cut-off turn on a Worker is woken, not dropped or looped on ([abf2594](https://github.com/mattapperson/noetic/commit/abf2594))
* fix(core): a decision that cannot be taken is refused, not half applied ([7d07818](https://github.com/mattapperson/noetic/commit/7d07818))
* fix(core): a held call's result is given by a decision item only ([6be6795](https://github.com/mattapperson/noetic/commit/6be6795))
* fix(core): a message delivered again mid-turn no longer runs twice ([caea6df](https://github.com/mattapperson/noetic/commit/caea6df))
* fix(core): a parked turn is no longer lost to a wake, a message or a catch ([710413e](https://github.com/mattapperson/noetic/commit/710413e))
* fix(core): a recorded effect is never redone unasked under a new version ([bfebbb9](https://github.com/mattapperson/noetic/commit/bfebbb9))
* fix(core): a recorded tool call replays whole: large results, item ids, UI, cleanup ([dffc4ab](https://github.com/mattapperson/noetic/commit/dffc4ab))
* fix(core): a reloaded agent's new call is not answered with an old result ([52d2443](https://github.com/mattapperson/noetic/commit/52d2443))
* fix(core): a second audit's findings: questions asked twice, silent holds, lost wakes ([c275b41](https://github.com/mattapperson/noetic/commit/c275b41))
* fix(core): a turn lease cannot reset its term, share a key, or be waited on forever ([b387004](https://github.com/mattapperson/noetic/commit/b387004))
* fix(core): close the holes a review found in leases, parking and held calls ([1790461](https://github.com/mattapperson/noetic/commit/1790461))
* fix(core): events are not acknowledged unstored, and a dropped one is named ([a29284b](https://github.com/mattapperson/noetic/commit/a29284b))
* fix(core): held calls no longer loop, get reused, or land under the wrong id ([1c93e4c](https://github.com/mattapperson/noetic/commit/1c93e4c))
* fix(core): schedules, sources and watchers stop losing or repeating work ([c855220](https://github.com/mattapperson/noetic/commit/c855220))
* feat: one approval seam for every path that asks a person ([f2979cc](https://github.com/mattapperson/noetic/commit/f2979cc))
* feat(core): a JSON workflow's version defaults to a hash of its document ([bcf4966](https://github.com/mattapperson/noetic/commit/bcf4966))
* feat(core): a resumed ACP step reloads its session and repeats no tool call ([0e9dfb2](https://github.com/mattapperson/noetic/commit/0e9dfb2))
* feat(core): cron() works on a host with no process between events ([f79a72f](https://github.com/mattapperson/noetic/commit/f79a72f))
* feat(core): decision_refused, for a decision that does not fit the thread ([4cfadbe](https://github.com/mattapperson/noetic/commit/4cfadbe))
* feat(core): decisions go through execute; one way in for hosts ([2a45239](https://github.com/mattapperson/noetic/commit/2a45239))
* feat(core): durable emit, triggers as data, a dead list, and message dedupe ([03cd64c](https://github.com/mattapperson/noetic/commit/03cd64c))
* feat(core): durable on tools, and a harness that wakes the turns it parked ([159d48e](https://github.com/mattapperson/noetic/commit/159d48e))
* feat(core): flow versions, stuck turns and a trail that outlives the ledger ([111210d](https://github.com/mattapperson/noetic/commit/111210d))
* feat(core): hold a tool call for a person and answer it with harness.resolve() ([30189d5](https://github.com/mattapperson/noetic/commit/30189d5))
* feat(core): one writer per turn with a storage-backed lease ([31bfa04](https://github.com/mattapperson/noetic/commit/31bfa04))
* feat(core): park a waiting turn and wake it later ([7234b88](https://github.com/mattapperson/noetic/commit/7234b88))
* feat(core): record each tool call so a cut round resumes at the one that was running ([7b59fea](https://github.com/mattapperson/noetic/commit/7b59fea))

### BREAKING CHANGE

* a call that needs approval on a harness with no
approveToolCall is now held until harness.resolve() answers it. It used
to run unapproved with a warning, and a model's call to a connection
operation that needs approval used to be denied.

Specs 02, 08 and 09, the invoke-tool, errors and API docs, and the
agent-builder skill are updated.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
* a step's call to a connection operation that needs
approval, on a harness with no approveToolCall, is held instead of
denied. A coding agent's permission request that nothing settles, on a
step whose policy names no default, is held instead of denied; name
`default: 'deny'` to keep the old behavior.

Specs 08, 12, 23, 27, 29, 31 and 35, the matching docs, and the
agent-builder skill are updated.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
* an event whose turn failed five times is no longer
delivered again at the next start; call harness.replayTrigger(). A
message passed to execute() with a messageId whose turn already finished
is answered from the record instead of starting a new turn.

Specs 08, 23a and 35, the connections, durability and runtime docs, and
the agent-builder skill are updated.

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>

## @noetic-tools/core-v5.21.0 (2026-11-12)

* feat(core): drop the tool round cap (#160) ([c415b56](https://github.com/mattapperson/noetic/commit/c415b56)), closes [#160](https://github.com/mattapperson/noetic/issues/160)

## @noetic-tools/core-v5.20.0 (2026-11-04)

* feat: one way to attach MCP servers, served to every agent (#156) ([2195f69](https://github.com/mattapperson/noetic/commit/2195f69)), closes [#156](https://github.com/mattapperson/noetic/issues/156)

## @noetic-tools/core-v5.19.3 (2026-11-03)

* fix(core): hold a document's acp-agent nodes and MCP servers to host grants (#155) ([89ed3e6](https://github.com/mattapperson/noetic/commit/89ed3e6)), closes [#155](https://github.com/mattapperson/noetic/issues/155)

## @noetic-tools/core-v5.19.2 (2026-10-30)

* ci: publish prereleases from next to the next dist-tag (#152) ([0b247bc](https://github.com/mattapperson/noetic/commit/0b247bc)), closes [#152](https://github.com/mattapperson/noetic/issues/152)

## @noetic-tools/core-v5.20.0-next.1 (2026-10-30)

* fix: close the harness review gaps and pass the structural gate ([a8d710b](https://github.com/mattapperson/noetic/commit/a8d710b))
* feat: implement connections, profiles and verification ([7237309](https://github.com/mattapperson/noetic/commit/7237309))
* feat(core): tighten the harness API for connections and step arrays ([a417a35](https://github.com/mattapperson/noetic/commit/a417a35))
* chore(core): release 5.19.1-next.1 [skip ci] ([4a087e2](https://github.com/mattapperson/noetic/commit/4a087e2))
* ci: publish prereleases from next to the next dist-tag ([5c9f714](https://github.com/mattapperson/noetic/commit/5c9f714))

## @noetic-tools/core-v5.19.1 (2026-10-30)

* fix(core): resume a cut-off model round from the items it finished ([c6c46b6](https://github.com/mattapperson/noetic/commit/c6c46b6)), closes [#153](https://github.com/mattapperson/noetic/issues/153)

## @noetic-tools/core-v5.19.1-next.1 (2026-10-29)

* ci: publish prereleases from next to the next dist-tag ([5c9f714](https://github.com/mattapperson/noetic/commit/5c9f714))

## @noetic-tools/core-v5.19.0 (2026-10-27)

* fix(core): bound held spend by request bytes and save decide() generation ids from headers ([976a075](https://github.com/mattapperson/noetic/commit/976a075)), closes [#149](https://github.com/mattapperson/noetic/issues/149)
* fix(core): charge a failed model call's recorded rounds and keep rounds[0] honest ([b8eca4c](https://github.com/mattapperson/noetic/commit/b8eca4c))
* fix(core): count the bill of model rounds rejected by recovery ([e0f2270](https://github.com/mattapperson/noetic/commit/e0f2270)), closes [#146](https://github.com/mattapperson/noetic/issues/146)
* fix(core): hold a spend record at its ceiling once it reads again ([18c7290](https://github.com/mattapperson/noetic/commit/18c7290))
* fix(core): keep a spend record the store reads as nothing while its key lists ([a20c0b0](https://github.com/mattapperson/noetic/commit/a20c0b0))
* fix(core): keep harness mirrors and docs in step with the drain report ([3fd203f](https://github.com/mattapperson/noetic/commit/3fd203f))
* fix(core): keep unreadable spend records pending instead of skipping them ([fc1931f](https://github.com/mattapperson/noetic/commit/fc1931f)), closes [#147](https://github.com/mattapperson/noetic/issues/147)
* fix(core): price a ceiling at the dearest rate the model publishes ([1f9540e](https://github.com/mattapperson/noetic/commit/1f9540e))
* fix(core): report a drained call's cost exactly as it was charged ([8daf8df](https://github.com/mattapperson/noetic/commit/8daf8df))
* fix(core): size a round's tools by the JSON Schema the wire carries ([0e0a710](https://github.com/mattapperson/noetic/commit/0e0a710))
* fix(types): list unreadable spend records in PendingSpend's own shape ([d340956](https://github.com/mattapperson/noetic/commit/d340956))
* test(core): format the torn-read spend test ([9300060](https://github.com/mattapperson/noetic/commit/9300060))
* feat(core): resolve graceful stops with a drain report that carries each call's cost ([1250357](https://github.com/mattapperson/noetic/commit/1250357)), closes [#148](https://github.com/mattapperson/noetic/issues/148)

## @noetic-tools/core-v5.18.0 (2026-10-26)

* feat(core): graceful stop with cancel(ctx, { drainMs }) ([8fed546](https://github.com/mattapperson/noetic/commit/8fed546)), closes [#145](https://github.com/mattapperson/noetic/issues/145)
* feat(core): record paid model dispatches and settle cut-off bills ([b64bf61](https://github.com/mattapperson/noetic/commit/b64bf61)), closes [#144](https://github.com/mattapperson/noetic/issues/144)
* feat(core): report cut-off drain calls by dispatch and generation id ([caa45f7](https://github.com/mattapperson/noetic/commit/caa45f7))
* fix(core): settle each cut-off bill exactly once and keep billed calls recorded ([f0fb58b](https://github.com/mattapperson/noetic/commit/f0fb58b))
* fix(core): tighten graceful-stop drains ([da087ca](https://github.com/mattapperson/noetic/commit/da087ca))

## @noetic-tools/core-v5.17.0 (2026-10-26)

* feat(core): durable steers and steer-triggered recall (#141) ([0c7b185](https://github.com/mattapperson/noetic/commit/0c7b185)), closes [#141](https://github.com/mattapperson/noetic/issues/141)

## @noetic-tools/core-v5.16.1 (2026-10-26)

* fix(core): restore custom items from steps outside agentGraph ([6cf867e](https://github.com/mattapperson/noetic/commit/6cf867e))

## @noetic-tools/core-v5.16.0 (2026-10-26)

* feat(core): typed custom items that stream events and a final item ([ce8b253](https://github.com/mattapperson/noetic/commit/ce8b253))

## @noetic-tools/core-v5.15.1 (2026-10-26)

* perf(core): find a ledger entry's subtree by binary search ([b2e7ade](https://github.com/mattapperson/noetic/commit/b2e7ade))

## @noetic-tools/core-v5.15.0 (2026-10-26)

* feat(core): steer a running turn with next-item delivery and onSteer layers (#139) ([bb468d8](https://github.com/mattapperson/noetic/commit/bb468d8)), closes [#139](https://github.com/mattapperson/noetic/issues/139)

## @noetic-tools/core-v5.14.1 (2026-10-26)

* fix(core): cap span events so a long-running loop's trace stays bounded ([bae67fd](https://github.com/mattapperson/noetic/commit/bae67fd))
* perf(core): build execution paths lazily and drop counts under finished steps ([0abcb42](https://github.com/mattapperson/noetic/commit/0abcb42))

## @noetic-tools/core-v5.14.0 (2026-10-26)

* chore(core): keep core on 5.x and types on 3.x ([3b1212f](https://github.com/mattapperson/noetic/commit/3b1212f))
* chore(core): release 6.0.0 [skip ci] ([f9d8a17](https://github.com/mattapperson/noetic/commit/f9d8a17))
* chore(core): release 6.1.0 [skip ci] ([fd7137a](https://github.com/mattapperson/noetic/commit/fd7137a))
* feat(core): let any step emit items before a workflow ends ([28352e5](https://github.com/mattapperson/noetic/commit/28352e5))
* feat(core): read durability from storage only, add durability: false and billedCost ([12e081f](https://github.com/mattapperson/noetic/commit/12e081f))
* feat(core): resume durable executions on a new harness by default ([635965b](https://github.com/mattapperson/noetic/commit/635965b))

### BREAKING CHANGE

* `environment.storage.checkpointStore: false` is replaced by
the top-level harness option `durability: false`. Context gains a required
`billedCost` field. While durability is on, sessions keep no in-memory
history.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Signed-off-by: Matt <me@mattapperson.com>
* CheckpointSchemaVersion is 3; v2 snapshots are rejected
with CHECKPOINT_SCHEMA_MISMATCH. A harness given a storage adapter is now
durable by default (pass `checkpointStore: false` for the old behaviour).
StepLedgerStats replaces `evicted` with `droppedFull` and `pruned`;
StepLedgerWindow replaces `oldestSeq` with `seqs`; StepLedger.take takes an
`inputHash`. Restoring a context after a finished run no longer replays
that run.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Signed-off-by: Matt <me@mattapperson.com>

## @noetic-tools/core-v5.13.0 (2026-10-26)

* feat(core): settle subprocess handles the moment they finish ([40f6741](https://github.com/mattapperson/noetic/commit/40f6741))

## @noetic-tools/core-v5.12.0 (2026-10-26)

* fix: finish the expr rename and show compute and expr in the inspector ([42af900](https://github.com/mattapperson/noetic/commit/42af900))
* feat(core): add infinite loops, recursive subflows, and decide-driven loop exits to JSON workflows ([c9c201a](https://github.com/mattapperson/noetic/commit/c9c201a))
* feat(core): add the expr until predicate to JSON workflows ([da9a553](https://github.com/mattapperson/noetic/commit/da9a553))
* feat(core): bound expression evaluation by steps, depth, length, and time ([4aa8bc5](https://github.com/mattapperson/noetic/commit/4aa8bc5))
* feat(core): finish the JSON workflow compute node ([df5f857](https://github.com/mattapperson/noetic/commit/df5f857))
* feat(core): route conditional nodes on JSONata expr tests ([d2afcee](https://github.com/mattapperson/noetic/commit/d2afcee))
* test(core): guard jsonata against code generation for Workers ([1a5f4a3](https://github.com/mattapperson/noetic/commit/1a5f4a3))
* wip(core): merge partial JSONata expression work onto loop/recursion/decide branch ([7c4a718](https://github.com/mattapperson/noetic/commit/7c4a718))

## @noetic-tools/core-v5.11.0 (2026-10-25)

* feat(core): toolChoice, needsApproval enforcement, onParentUpdate and layer hook spans (#128) ([f0db6cd](https://github.com/mattapperson/noetic/commit/f0db6cd)), closes [#128](https://github.com/mattapperson/noetic/issues/128) [#124](https://github.com/mattapperson/noetic/issues/124) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123)

## @noetic-tools/core-v5.10.0 (2026-10-25)

* feat(core): fix spec mismatches in step variants, spawn and observability (#124) ([ab46b6a](https://github.com/mattapperson/noetic/commit/ab46b6a)), closes [#124](https://github.com/mattapperson/noetic/issues/124) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123) [#121](https://github.com/mattapperson/noetic/issues/121) [#122](https://github.com/mattapperson/noetic/issues/122) [#123](https://github.com/mattapperson/noetic/issues/123)

## @noetic-tools/core-v5.9.0 (2026-10-24)

* feat(core): error model fixes and replay follow-ups for #111 and #115 (#119) ([d85827e](https://github.com/mattapperson/noetic/commit/d85827e)), closes [#111](https://github.com/mattapperson/noetic/issues/111) [#115](https://github.com/mattapperson/noetic/issues/115) [#119](https://github.com/mattapperson/noetic/issues/119) [#117](https://github.com/mattapperson/noetic/issues/117) [#115](https://github.com/mattapperson/noetic/issues/115) [#115](https://github.com/mattapperson/noetic/issues/115) [#111](https://github.com/mattapperson/noetic/issues/111) [#115](https://github.com/mattapperson/noetic/issues/115) [#111](https://github.com/mattapperson/noetic/issues/111) [#101](https://github.com/mattapperson/noetic/issues/101)

## @noetic-tools/core-v5.8.0 (2026-10-24)

* feat(core): release fixes for issues #110–#117 (#118) ([529c45d](https://github.com/mattapperson/noetic/commit/529c45d)), closes [#117](https://github.com/mattapperson/noetic/issues/117) [#118](https://github.com/mattapperson/noetic/issues/118) [#110](https://github.com/mattapperson/noetic/issues/110) [#112](https://github.com/mattapperson/noetic/issues/112) [#115](https://github.com/mattapperson/noetic/issues/115) [#110](https://github.com/mattapperson/noetic/issues/110) [#115](https://github.com/mattapperson/noetic/issues/115) [#114](https://github.com/mattapperson/noetic/issues/114) [#111](https://github.com/mattapperson/noetic/issues/111) [#111](https://github.com/mattapperson/noetic/issues/111) [#112](https://github.com/mattapperson/noetic/issues/112) [#113](https://github.com/mattapperson/noetic/issues/113) [#116](https://github.com/mattapperson/noetic/issues/116) [#110](https://github.com/mattapperson/noetic/issues/110) [#114](https://github.com/mattapperson/noetic/issues/114) [#115](https://github.com/mattapperson/noetic/issues/115) [#117](https://github.com/mattapperson/noetic/issues/117) [#110](https://github.com/mattapperson/noetic/issues/110)

## @noetic-tools/core-v5.7.0 (2026-10-21)

* feat(core): roll child-context usage up to every ancestor at spend time ([c5f760f](https://github.com/mattapperson/noetic/commit/c5f760f)), closes [#109](https://github.com/mattapperson/noetic/issues/109)

## @noetic-tools/core-v5.6.0 (2026-10-21)

* feat(core): add decide step, routeSwitch, and decisionsHistoryLayer (#108) ([ad0215c](https://github.com/mattapperson/noetic/commit/ad0215c)), closes [#108](https://github.com/mattapperson/noetic/issues/108)

## @noetic-tools/core-v5.5.0 (2026-08-19)

* feat(acp): serve a harness as an ACP agent ([68bdc20](https://github.com/mattapperson/noetic/commit/68bdc20))

## @noetic-tools/core-v5.4.2 (2026-08-19)

* test(core): pin the anchoring behaviour that reads as a renderDelta bug ([b2cffe1](https://github.com/mattapperson/noetic/commit/b2cffe1)), closes [#1](https://github.com/mattapperson/noetic/issues/1) [#2](https://github.com/mattapperson/noetic/issues/2) [#3](https://github.com/mattapperson/noetic/issues/3)

## @noetic-tools/core-v5.4.1 (2026-08-14)

* feat!: replace the sub-harness system with an Agent Client Protocol client (#89) ([eb4710d](https://github.com/mattapperson/noetic/commit/eb4710d)), closes [#89](https://github.com/mattapperson/noetic/issues/89)

## @noetic-tools/core-v5.4.0 (2026-08-12)

* feat!: unify Noetic public API naming (#68) ([38cb18f](https://github.com/mattapperson/noetic/commit/38cb18f)), closes [#68](https://github.com/mattapperson/noetic/issues/68)
* feat(core): support Standard Schema validators (#67) ([1751b6a](https://github.com/mattapperson/noetic/commit/1751b6a)), closes [#67](https://github.com/mattapperson/noetic/issues/67)

## @noetic-tools/core-v5.3.0 (2026-08-03)

* feat(core): anchor the prompt prefix and ask providers to cache it ([77d7685](https://github.com/mattapperson/noetic/commit/77d7685))

## @noetic-tools/core-v5.2.0 (2026-08-03)

* feat(context): rebuild the plan-mode briefing and hold recall to its budget ([4ea86e1](https://github.com/mattapperson/noetic/commit/4ea86e1))

## @noetic-tools/core-v5.1.0 (2026-08-02)

* feat(core): carry framework-authored items in getItemStream ([ecb33bc](https://github.com/mattapperson/noetic/commit/ecb33bc))

## @noetic-tools/core-v5.0.0 (2026-08-02)

* feat(core): add chat-sdk.dev integration and external channel read surface (#66) ([793f441](https://github.com/mattapperson/noetic/commit/793f441)), closes [#66](https://github.com/mattapperson/noetic/issues/66)

### BREAKING CHANGE

* AgentHarnessContract and the context-side harness
interface gain getChannelStream, and completed executions now close
their external channels — ChannelHandle.send after the root execution
finishes throws channel_closed where it previously silently succeeded.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HkrR1XYrDR5fo7tsYQW4be

## @noetic-tools/core-v4.0.0 (2026-08-02)

* fix: apply the rename to work that landed on main during the rebase ([aee8f21](https://github.com/mattapperson/noetic/commit/aee8f21))
* fix: harden step.workflow caching and plan-layer state loading ([3b10168](https://github.com/mattapperson/noetic/commit/3b10168))
* fix(core): export the step builder option types so the dist build emits ([1a16e74](https://github.com/mattapperson/noetic/commit/1a16e74))
* fix(core): restore the ctx.memory alias on the JSON-workflow tool path ([293019e](https://github.com/mattapperson/noetic/commit/293019e))
* feat: rename the memory layer system to context layers ([123810f](https://github.com/mattapperson/noetic/commit/123810f))
* feat(core): add step.workflow builder ([6d1e548](https://github.com/mattapperson/noetic/commit/6d1e548))
* feat(core): add subflow workflow node with named sub-workflow registry ([82c2529](https://github.com/mattapperson/noetic/commit/82c2529))
* feat(types): host the JSON workflow schema (moved from @noetic-tools/core) ([7f37ad6](https://github.com/mattapperson/noetic/commit/7f37ad6))
* feat(memory)!: rebuild plan layer on WorkflowDocument with named workflows ([caf5c91](https://github.com/mattapperson/noetic/commit/caf5c91))
* refactor(core): cut execute() complexity to fix structural-gate drift (#65) ([f0a0148](https://github.com/mattapperson/noetic/commit/f0a0148)), closes [#65](https://github.com/mattapperson/noetic/issues/65) [#64](https://github.com/mattapperson/noetic/issues/64) [#64](https://github.com/mattapperson/noetic/issues/64)

### BREAKING CHANGE

* FlowSchema/FlowNode and validateFlow/walkFlow/flowDepth
are removed from @noetic-tools/memory and @noetic-tools/core
(packages/memory/src/memory/flow-schema.ts and
packages/core/src/patterns/flow.ts deleted). PlanState.planTree is now a
WorkflowDocument and PlanState gains workflows.
PlanMemoryConfig.maxTreeDepth is renamed maxDepth; plan/setPlanTree
takes { document } instead of { tree }. Persisted legacy plan trees are
reset to null on load.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YaQitK6c9QsjU518ry8uX4

## @noetic-tools/core-v3.2.0 (2026-07-26)

* fix(core): cascade abort to child contexts and implement harness.cancel ([6d36c97](https://github.com/mattapperson/noetic/commit/6d36c97))
* feat(core): bound step-ledger retention by entry size and count ([dc6d338](https://github.com/mattapperson/noetic/commit/dc6d338))

## @noetic-tools/core-v3.1.0 (2026-07-26)

* feat(core): let restore() take the caller's context wiring ([2f28912](https://github.com/mattapperson/noetic/commit/2f28912)), closes [#59](https://github.com/mattapperson/noetic/issues/59)

## @noetic-tools/core-v3.0.0 (2026-07-26)

* feat(core): batch read on StorageAdapter, so ledger restore is not an N+1 ([6bb7b87](https://github.com/mattapperson/noetic/commit/6bb7b87)), closes [#58](https://github.com/mattapperson/noetic/issues/58)

### BREAKING CHANGE

* `ScopedStorage` gains a required `getMany` method. Code
that implements the interface directly — in practice only test doubles, as
the framework constructs the real one via `createScopedStorage` — must add
it. `StorageAdapter.getMany` is optional and breaks nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bp3JE94xvmxr4WWZ2bYjJJ

## @noetic-tools/core-v2.5.0 (2026-07-26)

* feat(core): step-level resume via a completion ledger ([2dfe7e3](https://github.com/mattapperson/noetic/commit/2dfe7e3))

## @noetic-tools/core-v2.4.0 (2026-07-24)

* feat(core): accept a ui declaration on the tool builders ([343915a](https://github.com/mattapperson/noetic/commit/343915a))

## @noetic-tools/core-v2.3.0 (2026-07-24)

* fix(core): update plan/setPlanTree tests to the wrapped input shape ([62d4b41](https://github.com/mattapperson/noetic/commit/62d4b41))
* feat(core): run the memory-layer boundary for fork paths and scope layers per spawn ([c7c4c5c](https://github.com/mattapperson/noetic/commit/c7c4c5c))
* feat(memory): give durable-task-state a write API and a fan-out-safe merge ([f09d5b0](https://github.com/mattapperson/noetic/commit/f09d5b0))

## @noetic-tools/core-v2.2.1 (2026-07-08)

* fix(core): make serveOpenUi stream the rendered UI end-to-end ([c579315](https://github.com/mattapperson/noetic/commit/c579315))

## @noetic-tools/core-v2.2.0 (2026-07-07)

* feat(core): expose OpenUI output codec to the JSON workflow runtime ([9bb9203](https://github.com/mattapperson/noetic/commit/9bb9203))
* feat(core): generative UI via OpenUI (codec, surface layer, tool UI, transport) ([3a922d8](https://github.com/mattapperson/noetic/commit/3a922d8))

## @noetic-tools/core-v2.1.0 (2026-06-30)

* feat(core): run node, dynamic fork, and server tools in the JSON workflow runtime (#53) ([50416d1](https://github.com/mattapperson/noetic/commit/50416d1)), closes [#53](https://github.com/mattapperson/noetic/issues/53)

## @noetic-tools/core-v2.0.0 (2026-06-28)

* style(core): satisfy biome objectWrap formatting in llm-client-resolve test ([7098e1f](https://github.com/mattapperson/noetic/commit/7098e1f))
* feat(core)!: default the LLM provider to the Noetic platform ([d079a6b](https://github.com/mattapperson/noetic/commit/d079a6b))

### BREAKING CHANGE

* callers relying on the implicit OpenRouter default (only
OPENROUTER_API_KEY set, no provider specified) must now pass
llm: { provider: 'openrouter' } or set NOETIC_API_KEY. The default inference
endpoint changed from openrouter.ai to platform.noetic.tools.

## @noetic-tools/core-v1.3.0 (2026-06-24)

* feat(core): stamp session + resource id on the workflow.run span (#52) ([bdb9a59](https://github.com/mattapperson/noetic/commit/bdb9a59)), closes [#52](https://github.com/mattapperson/noetic/issues/52)

## @noetic-tools/core-v1.2.3 (2026-06-24)

* fix(core): link llm.call/tool.call spans to their workflow node (NoeticAttr.NODE_ID) (#51) ([a8bcfd2](https://github.com/mattapperson/noetic/commit/a8bcfd2)), closes [#51](https://github.com/mattapperson/noetic/issues/51)

## @noetic-tools/core-v1.2.2 (2026-06-23)

* fix(core): wire traceExporter into model-call and workflow run path ([7af5890](https://github.com/mattapperson/noetic/commit/7af5890)), closes [#50](https://github.com/mattapperson/noetic/issues/50)

## @noetic-tools/core-v1.2.1 (2026-06-23)

* fix(core): init/recall/persist memory on harness.run() path (#49) ([3075d47](https://github.com/mattapperson/noetic/commit/3075d47)), closes [#49](https://github.com/mattapperson/noetic/issues/49) [#48](https://github.com/mattapperson/noetic/issues/48) [#48](https://github.com/mattapperson/noetic/issues/48)

## @noetic-tools/core-v1.2.0 (2026-06-15)

* feat(core): drive codeAgentWorkflow headlessly; SlopCodeBench uses it ([b959b8b](https://github.com/mattapperson/noetic/commit/b959b8b))

## @noetic-tools/core-v1.1.2 (2026-06-14)

* fix: small TUI bugs, dev-loop ergonomics, and post-merge type/docs gaps (#45) ([2757902](https://github.com/mattapperson/noetic/commit/2757902)), closes [#45](https://github.com/mattapperson/noetic/issues/45)
* Combine sub-harness steps for external coding agents ([314cb54](https://github.com/mattapperson/noetic/commit/314cb54))

## @noetic-tools/core-v1.1.1 (2026-06-14)

* fix(core): host workflow JSON schema so its $id URL resolves ([bc87e76](https://github.com/mattapperson/noetic/commit/bc87e76))

## @noetic-tools/core-v1.1.0 (2026-06-14)

* feat(core): publish JSON Schema for dynamic workflows + multi-model judge example ([d7add74](https://github.com/mattapperson/noetic/commit/d7add74))

## @noetic-tools/core-v1.0.0 (2026-06-10)

* fix: skip uninitialized layers, strip bun exports ([3c83c57](https://github.com/mattapperson/noetic/commit/3c83c57))
* fix: tighten item schema and shell command gates ([6d58546](https://github.com/mattapperson/noetic/commit/6d58546))
* feat(core)!: add async channel send back-pressure ([dcbdafa](https://github.com/mattapperson/noetic/commit/dcbdafa))
* feat(memory)!: harden layers, budget, lifecycle ([39cc778](https://github.com/mattapperson/noetic/commit/39cc778))
* build: resolve workspace deps to src via bun export condition ([b774d38](https://github.com/mattapperson/noetic/commit/b774d38))

### BREAKING CHANGE

* Context.send, AgentHarnessContract.send, and
ContextHarness.send return Promise<void> instead of void. Full
queue channels park internal senders (back-pressure) rather than
dropping the new value; callers must await or explicitly handle
the returned promise.
* durableTaskState() no longer accepts a config
object; DurableTaskStateConfig and DurableTaskStateSerializer
are removed.

## @noetic-tools/core-v0.3.0 (2026-06-08)

* fix(core): address adversarial review findings in memory layers ([bac97a0](https://github.com/mattapperson/noetic/commit/bac97a0))
* fix(core): durable-task-state persistence + steering guidance/casing/retries ([17a8ae8](https://github.com/mattapperson/noetic/commit/17a8ae8))
* fix(core): lifecycle consistency + fail-loud init for memory layers ([6b0bd01](https://github.com/mattapperson/noetic/commit/6b0bd01))
* fix(core): per-layer memory bugs (budget, dedup, merge, capture, recovery) ([1092992](https://github.com/mattapperson/noetic/commit/1092992))
* test(core): memory-layer audit tests (failing-by-design, prove layer bugs) [skip ci] ([f487dc6](https://github.com/mattapperson/noetic/commit/f487dc6))
* test(core): point memory audit tests at @noetic-tools/memory + types ([a4d17cc](https://github.com/mattapperson/noetic/commit/a4d17cc))
* feat(core): wire budget allocation, recall modes, assembleView cap, and re-render ([32e9f99](https://github.com/mattapperson/noetic/commit/32e9f99))
* refactor(core): extract memory layer system into @noetic-tools/memory + @noetic-tools/types (#39) ([4a4adc5](https://github.com/mattapperson/noetic/commit/4a4adc5)), closes [#39](https://github.com/mattapperson/noetic/issues/39) [#36](https://github.com/mattapperson/noetic/issues/36)

## @noetic-tools/core-v0.2.1 (2026-06-07)

* Combine these commits into a single commit message. ([e41abb2](https://github.com/mattapperson/noetic/commit/e41abb2))

## @noetic-tools/core-v0.2.0 (2026-06-05)

* feat(evals): add LongMemEval harness and temporal memory layer ([3df68cf](https://github.com/mattapperson/noetic/commit/3df68cf))

## @noetic-tools/core-v0.1.2 (2026-05-31)

* ci: default unsignalled core commits to a patch release ([afc473d](https://github.com/mattapperson/noetic/commit/afc473d))

## @noetic-tools/core-v0.1.1 (2026-05-30)

* fix(docs): correct model ids and Node ESM resolution ([3804935](https://github.com/mattapperson/noetic/commit/3804935))
* chore: remove internal barrel files (#28) ([43523d1](https://github.com/mattapperson/noetic/commit/43523d1)), closes [#28](https://github.com/mattapperson/noetic/issues/28)
* chore: rename @noetic/{cli,code-agent,platform-node} to @noetic-tools scope ([018991b](https://github.com/mattapperson/noetic/commit/018991b))

## @noetic-tools/core-v0.1.0 (2026-05-30)

* feat(core): add JSON workflow runtime — schema, hydrator, dynamic pattern ([436f57a](https://github.com/mattapperson/noetic/commit/436f57a))
* feat(core): align public API surface with framework docs ([180435c](https://github.com/mattapperson/noetic/commit/180435c))
* Docs site: NOETIC / section breadcrumb header + smaller mobile type (#37) ([e0bca9a](https://github.com/mattapperson/noetic/commit/e0bca9a)), closes [#37](https://github.com/mattapperson/noetic/issues/37)
