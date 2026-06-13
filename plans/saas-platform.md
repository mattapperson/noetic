# Noetic SaaS Platform — Plan

**Status:** Living document. Draft v1 (post-adversarial-review, post-OR-pragmatism debate). Not yet at implementation stage.

**How to read this doc:** [Decision history](#decision-history) captures *why* we landed where we did. [Current plan](#current-plan) is the actionable section. When something in the current plan changes, append the rationale to the decision history rather than overwriting — this is the audit trail.

## Maintenance conventions

This is a living document. Anyone editing it should follow these rules so it stays useful as an audit trail rather than degrading into a stale snapshot.

1. **Never overwrite a decision — append.** If a current-plan decision changes (e.g. we switch from Tinybird to ClickHouse, or revert from BYOK-default to managed inference), add a new numbered subsection to [§1 Decision history](#decision-history) explaining what changed, who/what drove it, and what alternatives were considered. *Then* update §2 to reflect the new state. The history section should read like a git log of strategic decisions.
2. **Decision-history entries are immutable once written.** Fix typos, but don't rewrite reasoning after the fact — even if a past decision turned out wrong. The wrongness is itself part of the audit trail and informs future decisions. Add a follow-up entry instead.
3. **The current plan (§2) is always the present tense.** No "we used to do X, now we do Y" language in §2 — that belongs in history. §2 should read as if a new engineer joined today and needed to know what's true now.
4. **Every change to §2 needs a changelog row.** Date, one-line change, driver (user feedback, panel review, customer call, engineer discovery, etc.). One sentence each.
5. **Open questions (§2.11) belong in §2, not history.** When an open question gets answered, move it to the relevant §2 section *and* add a decision-history entry capturing the rationale.
6. **Don't delete deferred items (§2.8) when shipped.** Move them out of "deferred" into the relevant phase or §2 section. The deferral list is a record of conscious "not now" choices, not a backlog.
7. **Scope cuts are decisions too.** If something gets killed (added to §2.12 "What's NOT in this plan"), add a decision-history entry. "We decided not to" is just as load-bearing as "we decided to."
8. **Disagreements are recorded with both sides.** When reviewers, advisors, or contributors disagree, capture both positions and the resolution. See [§1.3](#13-adversarial-panel-review) "Disagreements and resolutions" for the format.
9. **Date all entries.** Use `YYYY-MM-DD`. The relative ordering matters more than the exact day, but absolute dates survive cross-referencing.
10. **When in doubt, write it down.** The cost of a one-paragraph history entry is trivial; the cost of "why did we decide that?" with no answer six months later is large.

This doc becomes the spec / RFC source for the implementation work once P-1 completes. Treat it accordingly.

---

# Table of contents

1. [Decision history](#decision-history)
   - [1.1 Auth provider evaluation](#11-auth-provider-evaluation)
   - [1.2 Initial platform plan (v0)](#12-initial-platform-plan-v0)
   - [1.3 Adversarial panel review](#13-adversarial-panel-review)
   - [1.4 OpenRouter pragmatism debate](#14-openrouter-pragmatism-debate)
   - [1.5 Postgres minimization directive](#15-postgres-minimization-directive)
2. [Current plan](#current-plan)
   - [2.1 North star](#21-north-star)
   - [2.2 Strategic posture](#22-strategic-posture)
   - [2.3 P-1 — Pre-build](#23-p-1--pre-build-week-0-no-code)
   - [2.4 Architectural primitives](#24-architectural-primitives)
   - [2.5 Stack](#25-stack)
   - [2.6 Phased build](#26-phased-build)
   - [2.7 Day-1 must-gets](#27-day-1-must-gets)
   - [2.8 Deferred with confidence](#28-deferred-with-confidence)
   - [2.9 Pragmatic v1 → real version](#29-pragmatic-v1--real-version-later)
   - [2.10 Compliance & risk](#210-compliance--risk)
   - [2.11 Open questions](#211-open-questions-to-resolve)
   - [2.12 What's NOT in this plan](#212-whats-not-in-this-plan)
3. [Proposal: implementation specs](#proposal-implementation-specs)
   - [3.1 Why split](#31-why-split)
   - [3.2 Proposed specs (grouped, prioritized)](#32-proposed-specs-grouped-prioritized)
   - [3.3 Dependency graph](#33-dependency-graph)
   - [3.4 Conventions](#34-conventions)
   - [3.5 Location and naming](#35-location-and-naming)
4. [Next concrete step](#next-concrete-step)
5. [Changelog](#changelog)

---

# Decision history

## 1.1 Auth provider evaluation

**Question:** Which auth SaaS should Noetic use for accounts, OAuth, SSO, API key provisioning?

**Candidates evaluated:** Stytch, Kinde, WorkOS, Clerk, with honorable mentions for BetterAuth (self-host), Scalekit (SSO specialist), MojoAuth (passwordless).

**Summary findings:**

| Provider | Free tier | B2B features | Fit for Noetic |
|---|---|---|---|
| **WorkOS AuthKit** | 1M MAU free (incl. social, MFA, RBAC, passkeys, M2M) | First-class SSO/SCIM/RBAC, $125/SSO connection (drops with scale) | **Best fit** — free tier scales with us; enterprise pricing matches enterprise revenue |
| Clerk | 10K MAU, then $0.02/MAU | Strong React components, weak on M2M/API keys | Weak fit — strengths (UI components) don't match a CLI/SDK-first product |
| Kinde | 10.5K MAU, then $25/mo flat | M2M, orgs, RBAC, SAML SSO bundled cheaply | Good middle ground; younger ecosystem |
| Stytch | 10K MAUs, then $0.01–0.05/MAU | Passwordless-first, fraud detection | Skip — Twilio acquisition makes it a less safe long-term bet |

**Decision: WorkOS AuthKit.**

**Reasoning:**
- 1M-MAU free tier means user accounts cost $0 for years on a dev-tools product where most signups don't convert.
- SSO-per-connection pricing model matches the revenue shape (charge enterprise customers more, pay WorkOS per connection — clean margins).
- M2M auth is first-class, not bolted on (critical for CLI/agent auth).
- Path to SAML/SCIM without replatforming when enterprise customers ask.
- API-key issuing UX is something we'd build custom anyway for a CLI product, so Clerk's components aren't a real advantage.

**Trade-offs accepted:**
- We build the API-key-issuing dashboard ourselves on top of WorkOS M2M primitives (or use Unkey — TBD in P2).
- No bundled feature flags / analytics / billing (use PostHog + Stripe — better tools).

## 1.2 Initial platform plan (v0)

**Scope brief (user):** Build a SaaS platform supporting accounts, member management, account-level roles/scopes/grants for self-serve admin/user management, usage buckets with overages and accounting, user-creatable API keys, and metered usage that supports any combination of tokens, tool calls, elapsed time, throughput, storage. Goal: flexible foundation that won't need a rewrite, but pragmatic enough to ship.

**Inference layer (v0):** Whitelabeled OpenRouter proxy — mirror their API shape so SDKs work, strip OR headers, alias model IDs.

**v0 architectural primitives:**
- Account = WorkOS Organization
- Member = user-in-account
- Role = bundle of scopes (built-ins: owner/admin/member)
- Scope/Grant = atomic permissions, `hasScope(member, scope, account)` as the only authz check
- ApiKey = belongs to Member or Account, prefix + sha256 storage
- Bucket = metered allowance per (metric, period) with overage_price and hard_cap
- UsageEvent = append-only immutable rows with idempotency_key + dims jsonb

**v0 core design decisions:**
1. Usage as event-sourced metrics, not counters. New metric = one producer change.
2. Scopes in the hot path, roles only in UI.

**v0 phases (6–8 weeks, one engineer):**
- P0 Foundation → P1 Account self-serve → P2 API keys → P3 Inference gateway (whitelabel OR) → P4 Metering + buckets → P5 Billing + overages → P6 Polish

**Verdict on v0:** Strong on event-sourced primitives and bought-not-built auth/billing. But the inference monetization model and several correctness decisions had structural problems that the panel surfaced.

## 1.3 Adversarial panel review

Ran three reviewers in parallel: Senior PM (dev-tools/AI infra), Principal Engineer (billing/metering infrastructure), and CEO advisor (serial AI-infra founder with exits). Each independently critiqued v0; findings synthesized.

### Fatal flaws (raised by 2+ reviewers)

**1. Whitelabel-OpenRouter-proxy is a structural business mistake.** (PM + CEO)
- OR is itself a wholesaler with razor-thin margin. Adding a second markup gives no pricing power.
- Customers ask "why not use OR directly at cost?" — plan has no answer (no caching, no fallback routing, no eval integration).
- Makes Noetic merchant-of-record → fraud + chargeback + GDPR-processor exposure.
- CEO: "stolen-card attacker burns $20K of Claude tokens in 10 minutes, chargeback at 60 days, Stripe holds 10–25% reserve. This single risk can take the company down."
- Buries the actual moat (typed agent framework + memory + eval/GEPA) under SaaS plumbing competitors already built.

**2. In-memory 10s-flush bucket counter is unsound.** (Engineer + CEO)
- Once gateway scales horizontally, every pod has its own counter. Customer at 95% of hard cap can fan out concurrent requests across N pods and burn 5–10× the cap before any pod flushes.
- Hard caps non-enforceable; unbillable upstream cost on free accounts.
- "<1ms bucket check" budget conflicts with "Postgres 1-query aggregate lookup" — pick one.

**3. Stripe legacy metered + nightly reporter will silently produce wrong invoices.** (Engineer + CEO)
- Legacy metered is being deprecated in favor of Billing Meters API.
- No story for partial failures, clock skew at period boundaries, refunds when upstream fails post-emit.
- "Nightly reporter fails for 3 days → you eat the bill."

**4. Custom scope/grant + custom audit log + custom rate limiting + custom webhooks over-built for week 1.** (PM + Engineer + CEO)
- Built-ins cover 95% per plan's own admission — three hardcoded roles don't need a scope engine yet.
- Postgres-based rate limiting is a cliff at moderate traffic; Cloudflare/Upstash is 10 lines.
- Building reliable webhook delivery is a 2-week project; Svix exists.
- Unkey can delete most of P2 entirely.

**5. No GTM / ICP / design partners before 6–8 engineer-weeks of plumbing.** (CEO)
- Plan word-count includes zero instances of "customer."
- Building what Portkey/Helicone/Vellum/LangSmith already shipped — most consolidating or pivoting because the layer is commoditized.
- Noetic's actual differentiator (framework, memory, eval, GEPA) gets zero engineer-weeks in v0.

**6. No time-to-first-token story.** (PM)
- Plan marches signups through org/role/invite/bucket UI before they can `curl` a completion.
- Competitors are <60 seconds to first token.
- "#1 killer of dev-tools activation funnels."

**7. No pricing page as a deliverable.** (PM)
- Treated as Stripe config. No tier design, free-tier limits, public /pricing, or calculator.
- No decision on which metrics (tokens, tool calls, elapsed time, throughput, storage) are billable line items vs internal observability vs soft rate limits.
- PM: "elapsed time" and "throughput" as billable metrics are developer-hostile — slow model = higher bill, customer pushback every sales call.

**8. Prepaid credits deferred will cost mid-market deals.** (PM)
- Plan claim "B2B dev tools customers want postpaid invoicing" is false for the self-serve cohort.
- Postpaid metered + hard_cap → chargebacks and a runaway-agent HN post within a quarter.
- OpenAI, Anthropic console, OR, Replicate all onboard with prepaid credits.

**9. No SOC2 / GDPR / data-residency posture.** (Engineer + CEO)
- Soft-delete doesn't meet GDPR Article 17 timelines.
- If ICP is teams/enterprise, SOC2 evidence collection starts week 1, not month 6.
- Whitelabel proxy makes Noetic the data processor under GDPR; EU AI Act Article 50 transparency obligations land on us.

### Engineer-flagged correctness traps (single-reviewer but high-credibility)

| Issue | Fix |
|---|---|
| Raw sha256 for API key storage — DB leak enables offline GPU validation | HMAC-SHA256 with KMS-stored pepper |
| Audit log "in same transaction as mutation" breaks when mutation calls Stripe/WorkOS | Outbox pattern: audit captures intent, worker performs external call |
| WorkOS org webhook mirror has split-brain (delayed/reordered/dropped) | Treat WorkOS as source of truth on read path; 60s cache + daily reconciliation; webhooks for invalidation only |
| Inference gateway has no `Idempotency-Key` support → retries double-charge | Honor header (24h TTL fingerprint cache) |
| Audit log mutability — Postgres rows writable, fails SOC2 | Append-only table with `REVOKE UPDATE/DELETE` from app role |
| `UsageEvent.dims jsonb` PII risk if prompts/tool-args land there | Schema-validate at producer |
| Account ID in URL alone doesn't prevent IDOR | Postgres RLS or typed `AccountScope` repo + CI cross-tenant pen-test |
| Idempotency key uniqueness scope undefined | `UNIQUE(account_id, idempotency_key)` partial-indexed by ts |
| No cost reservation flow — stream completes before settle | Reserve worst-case (max_tokens × price) pre-call; settle on completion |

### Build-vs-buy gaps (CEO)

Engineer-weeks better spent on the moat:
- **Unkey** for API keys → deletes most of P2
- **Stripe Customer Portal + Billing Meters API** → deletes most of P5 billing UI
- **Svix** for customer webhooks → deletes P6 webhook infra
- **Tinybird / ClickHouse Cloud** for UsageEvent ingest day 1 → kills the future "we'll migrate from Postgres" rewrite
- **Upstash Redis** for rate limiting → 10 lines, kills custom Postgres RL

### Disagreements and resolutions

| Topic | Positions | Resolution |
|---|---|---|
| Should the inference proxy exist in v1? | CEO: kill it, BYOK is better. PM: keep it but reframe as agent-observability-native (the wedge). Engineer: silent, takes it as given but demands authoritative bucket checks. | Compromise: ship BYOK as default (customer plugs in their OR/Anthropic/OAI key, Noetic captures traces + metering); offer opt-in managed inference for design partners only behind CC + manual review + hard caps. Preserves PM's observability wedge while removing CEO's margin/fraud/GDPR objections. |
| How custom should auth/scope/audit/keys layer be? | All three reviewers agree it's over-built. CEO goes furthest (Unkey, Svix, Stripe Portal). Engineer wants scope-check shape kept for hot-path correctness. PM wants it kept for future custom roles. | Keep `hasScope(member, scope, account)` signature so migration is data-only later. V1 implementation: hardcoded role→scope map (no scope table, no grant UI). Evaluate Unkey for keys. Use Svix when first customer asks for webhooks. Audit log: outbox + append-only Postgres + `REVOKE UPDATE/DELETE`. |
| Postgres vs ClickHouse/Tinybird for UsageEvent? | Engineer: Postgres fine for ingest but aggregate queries degrade in weeks. CEO: start with Tinybird day 1, one extra day deletes a P1 rewrite. PM: silent. | Tinybird (or ClickHouse Cloud) day 1. One day of work, deletes rewrite, gives near-real-time current-hour usage for free (which PM also requires for activation). Postgres remains OLTP for accounts/keys/buckets/billing_period_summary. |

### Panel's one-sentence verdict

> The plan correctly bets on event-sourced usage and bought-not-built auth/billing primitives, but it must (1) abandon the whitelabel-reseller inference proxy in favor of BYOK-default + observability-native gateway tied to `@noetic-tools/core`, (2) replace the in-memory bucket counter with an authoritative shared-store reservation before forwarding upstream, and (3) front-load GTM, pricing, prepaid credits, time-to-first-token, and Stripe Billing Meters — otherwise it ships as a worse-Portkey with unbillable upstream cost, broken hard caps, and a developer-hostile activation funnel.

## 1.4 OpenRouter pragmatism debate

**User's pushback after panel review:** "Agree that in the longer run, using OpenRouter is a negative, but to get off the ground it would significantly speed things up."

**Key insight that emerged:** The panel was conflating two separable uses of OR.

| Use | Speed-up | Cost |
|---|---|---|
| **OR as upstream provider** (one API, model catalog, normalized streaming, one vendor bill) | Real, large — weeks saved on provider integration, model catalog, SSE normalization, fallback routing | Basically nothing — vendor decision like picking Postgres |
| **OR as customer-facing billing model** (resell tokens with markup, become merchant-of-record, operate buckets priced in $$) | Marginal — the hard parts (reservation, idempotency, Stripe meters, audit, fraud) exist regardless of upstream | The whole panel objection list: margin trap, chargeback exposure, GDPR processor, positioning crisis |

**Resolution:** Keep #1, drop #2. The OR speedup is real but lives in the SDK/streaming/model-catalog layer, not the billing layer. BYOK-default + small trial-credits pool is *less* work than the original plan (no Stripe markup math, no fraud controls, no $$-denominated reservation), not more.

**The hedge:** If P-1 customer discovery reveals the ICP is non-technical buyers (PMs, internal-tools teams) who won't go get an OR key, managed inference at a markup becomes the product. For the *developer* ICP that `@noetic-tools/core` implies, BYOK + trial pool wins.

**What the trial-credits pool looks like operationally:**
- A single pool funded out of *Noetic's* OR account
- Capped at $5/account lifetime, no overage, no Stripe involvement
- Hits the cap → "add your own key to continue"
- Weekend of work, not a phase

This decision drives most of [§2.2 Strategic posture](#22-strategic-posture).

## 1.5 Postgres minimization directive

**User directive:** "Avoid using Postgres for anything that isn't strictly necessary for relational data. It has a strong tendency to be the biggest infra bottleneck that's also the biggest headache to relieve."

**Why this matters:** Postgres is the easiest tool to reach for and the hardest to scale off of. Once a table has 100M rows, foreign keys to it, and prod queries depending on it, the migration cost is brutal — connection-pool exhaustion, lock contention on hot rows, vacuum storms, replica lag, and "the one query that needs a new index but the index build takes 4 hours" become permanent operational tax. Better to put non-relational workloads on purpose-built stores from day 1.

**Decision rule:** Postgres is the answer **only when** the workload requires *all of*: (a) joins across multiple entities, (b) ACID transactions, (c) foreign-key integrity, and (d) bounded row growth (≤ low millions over the product lifetime). Anything else goes to a purpose-built store.

**Application to this plan:**

| Workload | v0 location | v1 location | Reasoning |
|---|---|---|---|
| Accounts, members, api_keys, buckets (config), billing_period_summary | Postgres | **Postgres (kept)** | Joins, FK integrity, transactional updates, low-cardinality |
| `outbox` table | Postgres | **Postgres (kept)** | Must be in same tx as the mutation it backs; small, bounded |
| `UsageEvent` ingest | (panel moved to Tinybird) | **Tinybird** | High write volume, append-only, analytical queries |
| `bucket_state` (authoritative counter) | Postgres `UPDATE...RETURNING` *or* Redis | **Redis (Upstash) authoritative** | Hot-path atomic INCRBY/DECRBY; per-account row contention is the textbook Postgres scaling cliff. Periodic reconciliation against Tinybird UsageEvent sum is the durability story. |
| `audit_log` | Append-only Postgres with `REVOKE UPDATE/DELETE` | **Axiom (or BetterStack) tagged by account_id** | Append-only, never-joined, immutability is structural in a log store. Outbox stays in Postgres; worker ships from outbox to Axiom. Customer-facing audit read/export queries Axiom directly. |
| `Idempotency-Key` request fingerprint cache | (unspecified) | **Redis with TTL** | Pure KV with expiration; Postgres for this is malpractice |
| WorkOS membership 60s cache | (unspecified) | **Redis** | Same reasoning; high read rate, short TTL |
| `bucket_periods` archive | Postgres archive table | **Tinybird (or S3 parquet)** | Historical aggregates, time-series — purpose-built for analytical workloads |
| Trial credits balance ledger | (was Tinybird read model) | **Tinybird read model (kept)** | Already correctly placed |
| Rate limit counters | Upstash Redis | **Upstash Redis (kept)** | Already correctly placed |

**Net result:** Postgres holds the relational core (~6 tables) and the transactional outbox. Everything else lives on Redis (hot-path atomic ops + caches) or Tinybird/log store (high-volume append-only / time-series). The Postgres instance stays small enough that a Neon free-tier or Supabase free-tier instance covers v1 paid beta. No vacuum storms. No "we need to migrate off Postgres" project in year 2.

**Trade-off accepted:** Slightly more vendor surface area (Upstash + Axiom in addition to Tinybird, Stripe, WorkOS, Neon). The panel's "buy boring stuff" principle already pushed us in this direction; this directive completes it.

**One concern this raises:** The original panel engineer wanted the audit row written in the **same Postgres transaction** as the mutation, for atomicity. Moving audit to Axiom breaks that guarantee. **Resolution:** the outbox table stays in Postgres. Audit-relevant mutations write an `outbox` row in the same tx as the mutation; a worker ships outbox → Axiom at-least-once. We lose synchronous "audit committed iff mutation committed" but gain operational simplicity. The outbox row in Postgres is itself the durable record of intent; Axiom is the queryable form. SOC2 evidence collection can use either.

---

# Current plan

## 2.1 North star

Noetic's product is the **typed agent framework + memory layers + eval/GEPA optimization**. The SaaS exists to monetize that, not to resell tokens. Inference is a feature; the framework + eval loop is the moat.

**One-line pitch:** "Bring your OpenRouter/Anthropic/OpenAI key. Get a typed agent framework with traces tied to every run, eval scoring, prompt versioning, and memory layers — billed per seat / per agent-run / per eval, not per token."

## 2.2 Strategic posture

The load-bearing decisions. Change these → re-litigate the whole plan.

1. **BYOK-default for inference.** Customers paste their own OR/Anthropic/OAI key. We forward, we trace, we don't bill for tokens. This removes the margin trap, fraud/chargeback exposure, GDPR-processor risk, and merchant-of-record problem.
2. **Trial credits pool** (operational, not a billing tier) for the "30-second curl" demo case. Capped at $5/account, no overage, no Stripe involvement. Hits cap → "add your key to continue."
3. **Managed inference** ships as a feature flag for explicit design partners only — gated behind CC + manual review + hard caps. Not a v1 monetization path.
4. **OR as upstream is fine.** Model catalog, normalized streaming, one-vendor billing on our side. Vendor choice, not business model.
5. **Event-sourced usage** for everything billable. Buckets, invoices, dashboards are all read models computed from immutable `UsageEvent` rows.
6. **Buy the boring stuff.** WorkOS (auth), Stripe Billing Meters (billing), Tinybird (usage analytics), Upstash Redis (hot-path counters + caches), Axiom (audit log shipping), Unkey (keys — TBD), Svix (webhooks when needed). Custom code budget = UsageEvent ingestion + bucket check + the Noetic value layer.
7. **Postgres only when strictly relational.** Postgres holds accounts/members/api_keys/buckets-config/billing_period_summary/outbox — the small, joined, transactional core. Everything else (counters, caches, audit log, time-series, ingest) lives on a purpose-built store. See [§1.5](#15-postgres-minimization-directive) for the decision rule.

## 2.3 P-1 — Pre-build (week 0, no code)

Gates the build. Skip this and we ship the wrong product.

- [ ] 1-page GTM: named ICP, wedge, conversion event, channel
- [ ] 15 prospective-user calls; validate "BYOK + traces + eval" is the pull
- [ ] 3+ design partner LOIs (verbal is fine) before P0 starts
- [ ] Decide ICP → SOC2 path (teams = start week 1; indie devs = defer)
- [ ] Decide tier shape: Free / Pro / Team / Enterprise. Free-tier limits in agent-runs (or seats), not tokens
- [ ] Draft public `/pricing` page copy + calculator inputs

## 2.4 Architectural primitives

The shapes that are expensive to rip out later.

### Entity model
- **Account** ≈ WorkOS Organization. Billable tenant.
- **Member** — user-in-account relationship. Users can belong to many accounts.
- **Role** — named scope bundle. Built-ins: `owner` / `admin` / `member`. Custom deferred.
- **Scope** — atomic permissions. `hasScope(member, scope, account)` is the only auth check. V1 implementation: hardcoded role→scope map (no scope table). Signature preserved so custom roles ship as data later.
- **ApiKey** — Account-owned with `created_by` audit field. Member-owned only for the `noetic login` CLI flow with rotate-on-offboarding. Stored as prefix + HMAC-SHA256(secret, KMS-pepper). Env-prefixed: `noetic_live_*` / `noetic_test_*`.
- **Bucket** — metered allowance for a metric over a period: `{metric, period, included_quantity, overage_price, hard_cap}` (config in Postgres). V1 ships hardcoded buckets per account; config UI when ≥3 customers ask.
- **BucketState** — authoritative live counter `{account_id, metric, period_start, used, reserved}` stored in **Redis** (Upstash), accessed via atomic Lua script for reserve/settle/release. Periodic reconciliation against Tinybird UsageEvent sum (every 5min) is the durability/correctness backstop.
- **UsageEvent** — append-only, immutable: `{account_id, member_id?, api_key_id?, metric, quantity, unit, ts, idempotency_key, dims jsonb}`. Stored in **Tinybird** (not Postgres). PII-forbidden in `dims` (schema-validated at producer).
- **AuditLog** — append-only event stream shipped to **Axiom**, tagged by `account_id`. Written via outbox pattern: the audit-bearing mutation writes an `outbox` row in the same Postgres tx; a worker ships outbox → Axiom at-least-once. Customer-facing audit read/export queries Axiom directly.
- **Outbox** — small bounded Postgres table; transactionally linked to mutations that emit audit events or call external systems (Stripe/WorkOS/Axiom). Worker drains and marks rows complete.

### Two design decisions
1. **Usage as event-sourced metrics, not counters.** New metric = one producer change, zero schema changes. Reconciliation is free.
2. **Scopes in the hot path, roles only in UI.** Authorization is always `hasScope`. Adding "admin can do X but not Y" later is data.

### Authoritative bucket check (the non-negotiable)
- Pre-call: **reserve worst-case cost** (`max_tokens × model_price`) via an atomic Redis Lua script on `bucket_state:{account_id}:{metric}:{period_start}`. The script checks `used + reserved + worst_case ≤ included + overage_allowance` and atomically increments `reserved`. Single round-trip, no read-then-write race.
- For hard-cap accounts: **clamp `max_tokens` to remaining budget** — never trust the client.
- Post-call: settle actual usage (`reserved -= worst_case; used += actual`), release unused reservation. Settle in same Lua script call.
- Per-account in-flight concurrency cap (separate from rate limit).
- In-memory rollup is OK only as a soft pre-filter ahead of the authoritative check.
- **Durability/reconciliation:** Upstash Redis persistence covers single-node crashes. Every 5 minutes, a reconciler diffs Redis `used` against Tinybird `SUM(quantity) WHERE ts ≥ period_start`. Discrepancy > threshold → alert + automatic Redis correction. UsageEvent (Tinybird) is the source of truth for billing; Redis is the fast access path.

## 2.5 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend API | `packages/api` — Bun + Hono | Matches monorepo, fast HTTP, simple deploy |
| Relational core (OLTP) | Postgres (Neon or Supabase) + Drizzle — **only** accounts, members, api_keys, buckets-config, billing_period_summary, outbox | Joins, FK integrity, transactional. See [§1.5](#15-postgres-minimization-directive) for what does *not* go here. |
| Usage analytics + time-series | Tinybird (or ClickHouse Cloud) | High write volume, append-only, analytical queries — wrong fit for Postgres |
| Hot-path counters + caches | **Upstash Redis** — bucket_state, idempotency-key fingerprint, WorkOS membership cache, rate limit | Atomic INCRBY/Lua, per-key TTLs. Per-account row contention is the Postgres scaling cliff |
| Audit log | **Axiom** (or BetterStack) tagged by `account_id`, shipped from Postgres outbox | Append-only, immutable structurally, customer-facing read/export queries the log store directly |
| Auth | WorkOS AuthKit | 1M MAU free, M2M, SSO/SCIM when enterprise asks |
| Billing | Stripe Billing Meters API | Current API (legacy metered is deprecated) |
| API keys | Evaluate Unkey first; HMAC+KMS-pepper custom only if rejected | Don't build what's free |
| Webhooks (out) | Svix (when first customer asks) | Reliable delivery is a 2-week project we don't need now |
| Inference upstream | OpenRouter (default) + direct Anthropic/OAI | One API, normalized streaming |
| Dashboard | Extend `packages/web` (or split `packages/dashboard`) | Reuse existing shell |
| SDK | `@noetic-tools/sdk` thin wrapper | Surfaces trace IDs, ties to `@noetic-tools/core` |

## 2.6 Phased build

Target: paid beta in 6 weeks, one engineer. Realistic: 8 weeks.

### P0 — Foundation (wk 1)
- `packages/api` skeleton (Hono, Drizzle, migrations)
- Postgres schema (relational core only): `users`, `accounts`, `members`, `api_keys`, `buckets` (config), `billing_period_summary`, `outbox`
- Upstash Redis provisioned. `bucket_state` Lua scripts (reserve/settle/release) written and tested
- Axiom workspace provisioned. Outbox-shipper worker scaffold (Postgres outbox → Axiom)
- Tinybird workspace + `UsageEvent` ingest endpoint
- WorkOS AuthKit integration. **WorkOS is source of truth on read path**: 60s TTL membership cache (Redis), webhooks for cache invalidation only, daily reconciliation cron
- `hasScope()` middleware, default-deny. V1: hardcoded role→scope map
- Account ID in every URL **plus** Postgres RLS or typed `AccountScope` repo guard
- CI cross-tenant pen-test suite (try-to-read-another-tenant)

### P0.5 — Time-to-first-token (wk 1, parallel)
- Signup auto-provisions personal Account + default `noetic_test_*` key + trial bucket
- Success screen shows copy-paste `curl` (or BYOK setup + curl)
- Instrument **time-to-first-200** as north-star activation metric
- "Migrating from OpenRouter/OpenAI" landing snippet

### P1 — Account self-serve (wk 2)
- Members list, invite flow, role assignment UI
- **Customer-facing audit log** read + export API
- Outbox-pattern audit on Stripe/WorkOS mutations (no cross-network Postgres tx)

### P2 — API keys (wk 2–3)
- **Evaluate Unkey first.** Adopt unless env-prefix + per-key pepper requirements force custom
- If custom: `noetic_<env>_<24B-base62>`, stored as prefix + HMAC-SHA256 with KMS-pepper, constant-time compare on the HMAC
- Account-owned by default, `created_by` audit field, rotate-on-offboarding
- **Honor `Idempotency-Key` header** on the inference gateway (24h TTL fingerprint cache)

### P3 — BYOK + observability gateway (wk 3–4)
- `@noetic-tools/sdk` wraps the gateway, surfaces trace IDs, integrates with `@noetic-tools/core`
- **BYOK default**: customer key → forward to OR/Anthropic/OAI, capture usage from response, emit `UsageEvent` (token counts, model, tool calls, trace ID)
- **Trial credits** path: forward via Noetic's OR account, cap at $5 lifetime/account, no overage
- **Managed inference** path: feature flag for design partners only (CC + manual review + hard caps)
- Pass-through model IDs with `noetic/` prefix at most — **no model aliasing in v1**
- Read usage from final SSE chunk (no tee infrastructure in v1)

### P4 — Metering + buckets (wk 4–5)
- Authoritative bucket check in Redis (atomic Lua: reserve → settle → release)
- 5-minute reconciler diffs Redis `used` against Tinybird `SUM(quantity) WHERE ts ≥ period_start`; alerts + corrects on drift
- Tinybird `UsageEvent` dedup on `(account_id, idempotency_key)` with TTL by ts (Tinybird materialized view, not a Postgres unique index)
- `dims jsonb` producer-side schema validation (no prompts/tool args/secrets)
- Near-real-time current-hour usage view from Tinybird (10–30s lag)
- Spend alerts + graceful hard-cap UX (429 with `X-Remaining-Budget` header)
- Period rollover writes a `billing_period_summary` row in Postgres (one row per account per period — bounded, joinable); historical detail stays in Tinybird

### P5 — Billing + prepaid credits (wk 5–6)
- **Stripe Billing Meters API** (not legacy metered)
- Per-event idempotency key `{account_id}:{metric}:{usage_event_id}`
- 60s micro-batch reporter (not nightly)
- Self-computed `billing_period_summary`; nightly reconciliation diffs reported-to-Stripe vs UsageEvent sum
- Reporter lag SLO + alert + manual replay tool
- **Shadow-billing period** before going live
- **Prepaid credits** as a Tinybird-backed balance ledger — default for new accounts. Postpaid invoicing is enterprise opt-in behind credit check
- Stripe Customer Portal for self-serve subscription management
- Public `/pricing` page + calculator
- Subscription lifecycle: `past_due` → degrade (read-only), not lockout

### P6 — Polish / trust (wk 6+)
- Status page (Instatus, 99.9% target) wired to gateway health
- Resend for transactional email
- Svix for customer webhooks when first customer asks
- Upstash/Cloudflare rate limiting
- DPA + sub-processor list + prompt/response storage opt-out
- Deletion state machine: `soft_deleted → final_invoice_issued → pii_anonymized → hard_deleted-after-7y`
- ToS + AUP + upstream-outage refund policy

## 2.7 Day-1 must-gets

Cheap now, expensive later.

### Correctness
- Authoritative bucket check via **Redis Lua** (in-memory rollup is soft pre-filter only)
- Worst-case cost reservation pre-call; settle on response; clamp `max_tokens` for hard-cap accounts
- Per-account in-flight concurrency cap (Redis-backed)
- UsageEvent dedup on `(account_id, idempotency_key)` time-bounded (Tinybird materialized view)
- Honor `Idempotency-Key` header on the gateway (Redis cache, 24h TTL)
- Outbox pattern (Postgres) for Stripe/WorkOS/Axiom side-effects
- Stripe Billing Meters (not legacy metered) with deterministic idempotency keys
- Reporter lag SLO + reconciliation job (Tinybird vs Stripe vs Redis) + manual replay tool

### Security
- HMAC-SHA256 + KMS-stored pepper for API key hash (not raw sha256)
- Postgres RLS or typed `AccountScope` repo + CI cross-tenant pen-test suite
- Audit log shipped to Axiom via Postgres outbox (immutability is structural in the log store)
- Schema validator on `UsageEvent.dims` (no prompts/tool args/secrets)
- WorkOS as source of truth on read path; webhooks for cache invalidation only

### Data shape
- Env-prefixed API keys (`noetic_live_*` / `noetic_test_*`)
- Account ID in every URL (`/v1/accounts/{id}/...`)
- All money as integer cents/microcents
- `UsageEvent.dims jsonb` for free-form dimensions

### Product
- Signup auto-provisions personal Account + test key + trial bucket + curl on success screen
- Time-to-first-200 instrumented as north-star metric
- Customer-facing audit log read + export
- Near-real-time current-hour usage view
- Public `/pricing` page before paid beta
- Status page + stated 99.9% before paid beta

### Process
- 1-page GTM with named ICP and 3+ design partner LOIs gating the build
- Build-vs-buy decisions logged (Unkey, Stripe Portal, Svix, Tinybird, Clerk)

## 2.8 Deferred with confidence

| Item | Why deferred |
|---|---|
| Custom role builder UI | Built-ins cover 95% for the first year |
| SCIM | WorkOS adds it when an enterprise asks; pay per connection then |
| Multi-region inference | OR handles model-side routing; single-region OK until latency complaints arrive |
| Billing abstraction layer | Stripe *is* the billing service; no "in case we switch" |
| Postpaid as default | Prepaid covers the self-serve cohort; postpaid behind enterprise credit check |
| Tee-ing SSE for token counting | Final SSE chunk has usage; tee only matters if mid-stream-disconnect billing matters |
| Custom webhook delivery infra | Svix the day the first customer asks |
| Bucket config UI | Hardcoded one-per-metric until 3 customers ask |
| Model ID aliasing | Pass through with `noetic/` prefix; aliasing when needed |
| Real-time (sub-second) usage | 10–30s lag from Tinybird is plenty |
| Custom rate limiter | Upstash/Cloudflare |
| Hard-delete state machine | Soft-delete only; build the rest when first GDPR request lands (policy documented now) |

## 2.9 Pragmatic v1 → real version later

| Area | V1 | Later |
|---|---|---|
| Authz | Hardcoded role→scope map behind `hasScope()` | Scope table + custom roles + policy engine |
| Usage analytics | Tinybird (or ClickHouse Cloud) | Same — designed to scale |
| Bucket check | Redis Lua atomic reserve/settle + 5min Tinybird reconciler | Same — purpose-built from day 1 |
| Billing | Stripe Billing Meters + 60s micro-batches | Real-time meter events, prepaid balances, multi-currency |
| Inference | BYOK + small trial pool + opt-in managed | Same; managed scales with fraud/compliance maturity |
| Audit log | Axiom shipped from Postgres outbox | S3 + Athena + hash-chained (only if compliance forces it) |
| Webhooks (out) | Polling endpoints + Svix when asked | Same; Svix scales |
| Rate limiting | Upstash Redis | Same |

## 2.10 Compliance & risk

Decide ICP first; the answer drives the level.

- **GDPR:** publish DPA + sub-processor list + prompt/response storage opt-out by P5. Deletion state machine policy documented in P0.
- **SOC2:** if ICP is teams/enterprise, start evidence collection week 1 (Vanta/Drata). Audit log + access reviews + change management baseline.
- **Data residency:** EU customers will ask in the first call. Decide: US-only-with-disclosure for v1, EU region added when first €€€ contract requires it.
- **EU AI Act Article 50:** transparency obligations if we ship managed inference. Trivial if BYOK (customer is the deployer).
- **Fraud / chargebacks (managed inference only):** CC + small auth charge before any managed call. Hard caps for first 30 days. Manual review over `$X/day`. Signed ToS chargeback waiver.

## 2.11 Open questions to resolve

These need answers before the relevant phase starts.

- **Pricing units.** Per-seat? Per-agent-run? Per-eval? Combination? Tied to P-1 customer discovery.
- **Free-tier shape.** Agent-runs/month? Trial credit dollars? Days-of-access?
- **Unkey vs custom keys.** Need a 1-day spike to validate env-prefix + per-key pepper requirements against their API.
- **Tinybird vs ClickHouse Cloud.** Tinybird is faster to ship; ClickHouse is more control. Lean Tinybird unless cost projection at 100K MAU rules it out.
- **Dashboard split.** Extend `packages/web` or split `packages/dashboard`? Defer until P1 starts.
- **Trial credits funding.** Start with $5/account out of our OR account. Re-evaluate when 100 accounts have hit the cap.
- **Managed inference opt-in mechanic.** Application form? Sales call? Auto-enable above $X paid plan? Tied to first design partner ask.

## 2.12 What's NOT in this plan

- Reselling tokens with a markup
- Becoming merchant-of-record for inference
- Custom scope/grant atomic-permissions table for v1
- Member-owned API keys as a first-class concept
- Custom Postgres rate limiting
- Custom webhook delivery infrastructure
- SSE tee-ing in v1
- Whitelabel model ID aliasing
- Multi-region inference proxy
- Legacy Stripe metered billing

---

# Proposal: implementation specs

**Status:** Proposal — not yet approved. Adopt after P-1 completes (so customer discovery can refine scope before specs are written).

This plan doc is intentionally high-level — strategy, posture, primitives, phased outline. Once P-1 unlocks the build, the implementation needs concrete per-area specs that engineers can work from independently. This section proposes how to slice them.

## 3.1 Why split

The plan covers ~7 distinct concerns that touch different code, different vendors, and different parts of the stack. Holding them in one document is correct *now* (decision-making phase) but wrong once we're building — review cycles get slow, ownership blurs, and unrelated changes collide in the same diff.

Splitting into per-purpose specs gives us:

- **Independent ownership.** One engineer can own "Metering Spine" without blocking work on "Billing & Credits."
- **Reviewable scope.** A 20-page omnibus spec gets rubber-stamped; a 4-page focused spec gets actually read.
- **Parallel work.** Specs with no dependency edges can be drafted and implemented concurrently.
- **Stable interfaces.** The spec is the contract between areas. Changing `UsageEvent` shape becomes a spec amendment with notified owners, not a silent code change.
- **Matches existing convention.** The repo already uses `specs/NN-*.md` for the framework (`specs/01-step-type.md` through `22-cli-architecture.md`). SaaS specs should follow the same shape.

## 3.2 Proposed specs (grouped, prioritized)

Seven specs, in four priority tiers. Each spec describes the **ideal end state** of its area (per `.claude/rules/spec-guidelines.md` — no phased rollout language inside the spec itself; that's what this plan doc is for).

### Tier 1 — Foundation (nothing else ships without these)

**S1. Identity & Access Control**
Accounts, members, roles/scopes (hardcoded role→scope map behind `hasScope()`), WorkOS AuthKit as source-of-truth-on-read with 60s Redis cache + daily reconciliation, multi-tenancy enforcement (Postgres RLS *or* typed `AccountScope` repo + CI cross-tenant pen-test), audit log via Postgres outbox shipped to Axiom. Defines the auth contract every other spec depends on.

**S2. Metering Spine**
`UsageEvent` shape and ingest (Tinybird), `BucketState` in Redis with atomic Lua reserve/settle/release, worst-case-cost reservation semantics, max-tokens clamping for hard-cap accounts, idempotency rules, 5-minute reconciler diffing Redis vs Tinybird, `dims jsonb` PII schema validator. This is the metering contract every billable surface depends on.

### Tier 2 — Wedge (delivers customer value)

**S3. API Keys**
Generation (`noetic_<env>_<24B-base62>`), storage (HMAC-SHA256 with KMS-stored pepper, or Unkey adoption decision — Tier-1 spike), prefix-indexed lookup, constant-time HMAC compare, account-owned vs member-CLI-login model, rotate-on-offboarding, scope inheritance, `Idempotency-Key` header handling. Depends on S1 (auth) + S2 (idempotency primitives).

**S4. Inference Gateway & SDK**
BYOK forwarding to OR/Anthropic/OAI, trial-credits-pool path, opt-in managed-inference feature flag, trace tie-in to `@noetic-tools/core` runs, `@noetic-tools/sdk` thin wrapper, response usage emission to `UsageEvent`, SSE handling (no tee in v1). Depends on S3 (auth) + S2 (metering).

### Tier 3 — Monetization

**S5. Billing & Credits**
Stripe Billing Meters integration with deterministic per-event idempotency, 60s micro-batch reporter, `billing_period_summary` in Postgres, reconciliation jobs (Tinybird vs Stripe vs Redis), reporter-lag SLO + manual replay tool, prepaid credits ledger as Tinybird read model (default for new accounts), Stripe Customer Portal integration, subscription-lifecycle handling (`past_due` → degrade). Depends on S2 (metering) + S1 (accounts).

### Tier 4 — Activation & Trust (cross-cutting; touch many areas)

**S6. Activation & Pricing**
Signup auto-provision flow (personal account + test key + trial bucket + copy-paste curl on success screen), TTF-200 instrumentation, public `/pricing` page + calculator, migration-from-OR/OAI landing, near-real-time current-hour usage view (Tinybird-backed). Depends on S1 + S3 + S4 + S5. Lightweight spec — mostly UX flows and product copy.

**S7. Trust & Compliance**
Status page (Instatus, 99.9% target) wired to gateway health, customer-facing audit-log read+export API (Axiom-backed), DPA + sub-processor list publication, prompt/response storage opt-out, deletion state machine (`soft_deleted → final_invoice_issued → pii_anonymized → hard_deleted-after-7y`), SOC2 evidence baseline if ICP demands it, upstream-outage refund policy, ToS/AUP. Depends on S1 (audit) + S5 (billing for refund flows). Lightweight spec — mostly policy + integrations.

## 3.3 Dependency graph

```
S1 Identity & Access ──┬──→ S3 API Keys ──→ S4 Inference Gateway ──┐
                       │                                            ├──→ S6 Activation
S2 Metering Spine  ────┼──→ S4 (metering) ──────────────────────────┤
                       └──→ S5 Billing & Credits ───────────────────┤
                                                                    │
S1 + S5 ──→ S7 Trust & Compliance ──────────────────────────────────┘
```

**Implications for sequencing:**

- **S1 + S2 must be drafted and approved first.** They are the contract surface for everything else. Plan: lock these two specs before any other spec is written.
- **S3 and S4 can be drafted in parallel** once S1 + S2 are stable (S3 depends only on auth/idempotency primitives; S4 depends on those plus S3's key-validation hook, which is a stable interface even if S3 implementation isn't done).
- **S5 can be drafted in parallel with S3/S4** once S2 is stable (it depends on metering shape, not key/gateway internals).
- **S6 and S7 should be drafted last** — they ratify decisions made in S1–S5 rather than dictating them.

**Implementation order:** S1 → S2 → (S3 || S5) → S4 → S6 → S7. One engineer can sequence; two can collapse S3/S5 into parallel weeks.

## 3.4 Conventions

Follow the existing `.claude/rules/spec-guidelines.md` and `.claude/rules/sync-spec-code-docs.md` conventions:

- **Ideal state only.** Specs describe the final design. No "Current State" / "Target Architecture" sections, no `*(planned)*` annotations. Future ideas go in a `## Future Considerations` trailing section.
- **One spec, one responsibility.** If a spec grows past ~6 printed pages, it's covering two things — split it.
- **Cross-spec contracts are explicit.** When S3 (API Keys) says "the `Idempotency-Key` header is honored," link to the section of S2 (Metering) that defines the semantics. Specs reference each other; they do not silently assume.
- **Code ↔ Spec sync.** Per `sync-spec-code-docs.md`, runtime code must stay consistent with its spec. SaaS specs should be added to that doc's reference-mapping table when they land.
- **No phased language inside specs.** Phases live in this plan doc (§2.6). The spec describes what the system *is*, not what stages it shipped through.

## 3.5 Location and naming

The existing `specs/` directory holds framework specs (`01-step-type` through `22-cli-architecture`). SaaS platform specs are a different concern — same convention, separate namespace.

**Proposed location:** `specs/saas/NN-<name>.md`

```
specs/
├── 00-overview.md                  (existing — framework)
├── 01-step-type.md                 (existing — framework)
│   ...
├── 22-cli-architecture.md          (existing — framework)
└── saas/
    ├── 00-overview.md              (links to this plan doc + spec index)
    ├── 01-identity-access.md       (S1)
    ├── 02-metering-spine.md        (S2)
    ├── 03-api-keys.md              (S3)
    ├── 04-inference-gateway.md     (S4)
    ├── 05-billing-credits.md       (S5)
    ├── 06-activation-pricing.md    (S6)
    └── 07-trust-compliance.md      (S7)
```

**Rationale for the `saas/` subdirectory:** keeps framework-spec numbering stable (no renumber-on-conflict), makes it obvious at a glance which specs apply to which surface, and matches the existing project structure where SaaS is a new top-level concern alongside the framework rather than a continuation of it.

**Reference mapping update:** when these specs are created, add rows to `.claude/rules/sync-spec-code-docs.md` mapping each SaaS spec to its source directory (`packages/api/src/<area>/`) and any related docs.

## Open question

- **`specs/saas/` vs extending top-level numbering (26+).** The subdirectory keeps things visually grouped; flat numbering matches the established pattern more strictly. Lean subdirectory unless a maintainer has a strong preference.
- **Who owns each spec.** Once we know who's on the team, assign one DRI per spec. Specs without an owner rot.
- **Spec freeze policy.** Do we lock S1+S2 before writing S3–S7, or allow concurrent drafting with explicit "subject to change" tags? Recommend lock-before-draft for S1+S2 only; S3–S7 can iterate concurrently against frozen S1+S2 contracts.

---

# Next concrete step

Run **P-1** before any code. Specifically: write the 1-page GTM and get on 5 customer calls this week. The schema and `hasScope` signature are stable enough to start P0 in parallel if a second person is available, but a single engineer should sequence GTM → P0.

---

# Changelog

| Date | Change | Driver |
|---|---|---|
| 2026-06-12 | Initial v0 plan drafted (whitelabel OR proxy, custom scope/audit/RL infra, 6-8 week phases) | User scope brief |
| 2026-06-12 | Adversarial panel review (PM + Engineer + CEO) raised 9 fatal/cross-cutting issues; recommended BYOK pivot, authoritative bucket reservation, Stripe Billing Meters, build-vs-buy pass, P-1 GTM gate | Panel synthesis |
| 2026-06-12 | OR-pragmatism debate: separated "OR as upstream" (keep) from "OR as billing model" (drop). Resolved with BYOK-default + trial credits pool + opt-in managed mode | User pushback on panel |
| 2026-06-12 | Plan v1 documented with decision history | Living doc requirement |
| 2026-06-12 | Postgres minimization directive: Postgres holds only the relational core (6 tables + outbox). bucket_state → Redis Lua; audit_log → Axiom via outbox; Idempotency cache + membership cache → Redis; bucket_periods archive → Tinybird | User directive on infra bottleneck risk |
| 2026-06-12 | Added §3 proposal for splitting implementation into 7 per-purpose specs (S1–S7) under `specs/saas/`, in 4 priority tiers, with explicit dependency graph and conventions | User request — needed before P-1 completes so implementation can ramp without omnibus-spec review bottleneck |
