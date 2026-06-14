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
   - [1.6 Unkey rejected; in-house keys + verification cache](#16-unkey-rejected-in-house-keys--verification-cache)
   - [1.7 Cloudflare-first cloud strategy](#17-cloudflare-first-cloud-strategy)
   - [1.8 Observability graduated by paying-customer tier](#18-observability-graduated-by-paying-customer-tier)
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
   - [2.13 Cost-coverage invariants](#213-cost-coverage-invariants)
   - [2.14 Cloud architecture](#214-cloud-architecture)
   - [2.15 Observability & monitoring](#215-observability--monitoring)
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

## 1.6 Unkey rejected; in-house keys + verification cache

**Trigger:** User asked to evaluate whether Unkey is necessary and how to ensure free-tier cost-coverage doesn't break unit economics.

**Unkey pricing as of mid-2026** (updated since v0 plan was drafted):
- **Free:** 150K requests/month (up from 2.5K). "Request" = key verification *or* rate-limit check, no longer billed separately.
- **Pro:** $25/mo, tiered up to ~1M requests, **no overage charges** — exceeding the tier triggers an email, not a bill.
- **Scale:** ~$250/mo for 10M requests (down from $1,010/mo on the old model).

**The cost-coverage problem with any vendor on the auth hot path.** For a dev-tools product on BYOK inference, every CLI/SDK call hits the API-key verifier *before* it reaches OpenRouter. Free users have no incentive to be efficient. Realistic shape:
- ~10% of signups become weekly-active
- Active users on agent workflows generate 100–500 inference calls/day each
- 1K active free users × 200 calls/day × 30 = **6M verifications/month**

That blows through Unkey's 150K free tier at ~750 active users. Then we pay $25–250/mo on $0 of revenue. Not catastrophic, but a leak that scales with success.

**The structural fix is verification caching, not vendor choice.** Redis with a 60s TTL on `(api_key_hash) → {account_id, scopes}` cuts vendor/DB calls by 50–100× for any user making more than one call/minute. With caching, 6M verifications → ~60K — comfortably inside Unkey's free tier. **But once we have the cache, the marginal cost gap between Unkey and in-house collapses to near zero, and in-house becomes structurally cheaper.**

**In-house effort, honestly estimated:**

| Component | LoC | Time |
|---|---|---|
| Generate (env prefix + 24B base62) | ~10 | 30 min |
| Store (HMAC-SHA256 + KMS pepper, Postgres) | ~30 | 1 hr |
| Lookup (prefix index + constant-time HMAC compare) | ~40 | 2 hr |
| Redis verification cache (60s TTL) | ~30 | 1 hr |
| Revoke + invalidate cache | ~20 | 30 min |
| Per-key RPS limit (Redis token bucket on existing Upstash) | ~40 | 2 hr |
| Dashboard UI (create/list/revoke/last-used) | ~150 | 1 day |
| Tests | ~200 | 1 day |

**Total: ~3–4 days of one engineer.** The cryptographic primitives are stdlib; the surrounding infra (audit log, rate-limit, scope check) is already being built for other reasons. The v0 plan over-estimated this at ~1 week.

**Trade-offs analyzed:**

| Unkey gives | We already have / don't need |
|---|---|
| Pre-built rate-limit primitives | Upstash Redis token bucket (same thing, already in plan) |
| Analytics dashboard | Tinybird + our own metering dashboards |
| Per-key permissions UI | `hasScope()` system |
| Hosted verification endpoint | Local Postgres + Redis lookup is *faster* (no network) |
| Abuse detection | Noetic-policy specific; we build it either way |

| Unkey costs | Severity |
|---|---|
| 5–20ms added latency per call (network to Unkey) | Real — compounds on streaming inference |
| Vendor in auth hot path (their outage = our outage) | Real — undermines our 99.9% status-page claim |
| Key material custody outside our control | Real — adds DPA scope for enterprise customers |
| Migration cost if we ever leave | Real — every customer key would need rotation |
| Scaling cost as free-tier population grows | Tractable with caching but unnecessary friction |

**Decision: build in-house.** Three reasons:

1. The work is **3–4 days**, not a week, because the surrounding infra is already being built.
2. The structural cost-coverage answer is **verification caching**, which we need regardless of vendor — and once we have it, Unkey's free tier is unnecessary and its paid tiers are pure overhead with no offsetting feature win.
3. **Removing a vendor from the auth hot path** is a latency, reliability, and compliance win that compounds.

The original CEO-panel "use Unkey" rec came from a "don't build commodity stuff" instinct that's correct in general but wrong here: we're already paying the cost of the surrounding system. Unkey makes sense for a startup whose *only* infra need is keys. We're building 6 other things on Postgres + Redis + Axiom; keys are a 3-day extension, not a separate project.

**Cost-coverage invariants codified as architectural constraints** (see [§2.13](#213-cost-coverage-invariants)). The deeper question — "many users will hold keys without paying, how do costs stay covered?" — is answered by six locked-in invariants that hold regardless of vendor choice and ensure marginal cost per free user approaches fractions of a cent per month.

**Open question resolved:** §2.11 "Unkey vs custom keys — 1-day spike" is closed. No spike needed.

## 1.7 Cloudflare-first cloud strategy

**Trigger:** User asked to evaluate cloud infrastructure, optimizing for Cloudflare and only reaching for AWS/GCP where Cloudflare lacks or overcharges.

**Decision: ~95% Cloudflare for v1, with three external vendors for things Cloudflare doesn't offer.** No AWS or GCP at v1.

### What goes on Cloudflare

| Need | Cloudflare service | Rationale |
|---|---|---|
| API + inference gateway | Workers (Paid: $5/mo, 10M req + 30M CPU-ms included) | Hono runs natively; edge-deployed; SSE works (the 30s CPU limit is CPU-bound, inference proxying is idle-waiting). Free DDoS + WAF baked in. |
| Inference upstream wrapper | **AI Gateway** (free) | Sits between our Worker and OR/Anthropic/OAI — adds caching, real-time logs, cost tracking, provider fallback for free. Our Worker still owns auth + bucket + UsageEvent emission. |
| Background workers | Cron Triggers + Queues | Outbox shipper, 60s billing reporter, 5min reconciler. Cron is free with Workers Paid; Queues are $0.40/1M ops. |
| Dashboard hosting | Pages | Free at our scale; same-domain integration with Workers |
| Object storage | R2 | **Zero egress fees** — critical for usage exports, audit dumps, generated reports |
| DNS / CDN / WAF / Bot management | Cloudflare (already) | Free baseline |
| Secrets (HMAC pepper, vendor tokens) | Workers Secrets / Secrets Store | Sufficient for v1 — see KMS trigger below |
| Connection pooling to Postgres | **Hyperdrive** | Critical — Workers can't hold long-lived Postgres connections. Hyperdrive pools + caches + TLS-terminates. Free with Workers Paid. |

### External vendors (Cloudflare doesn't offer; not AWS/GCP either)

| Need | Vendor | Why not AWS/GCP |
|---|---|---|
| Postgres | **Neon** | Cloudflare has no managed Postgres. Neon is serverless Postgres designed for Workers + Hyperdrive — scales to zero, free tier covers v1. Aurora Serverless v2 minimum: ~$43/mo even idle. Cloud SQL smallest tier: ~$15–25/mo always-on. |
| Redis | **Upstash** | Cloudflare KV is eventually-consistent (~60s) — NOT a Redis substitute for atomic INCRBY or for the 60s verification cache which needs instant revoke. Durable Objects need a different programming model. Upstash REST API + pay-per-request fits Workers perfectly. ElastiCache Serverless minimum: ~$70–100/mo. Memorystore minimum: ~$50/mo. |
| Audit log shipping | **Axiom** | Standard Cloudflare Logpush target; free 500GB tier. |

### Where AWS or GCP would win — but don't yet, with explicit trigger conditions

| Service | What it provides | Trigger to add |
|---|---|---|
| AWS KMS / Cloud KMS | HSM-backed envelope encryption with key versioning, FIPS 140-2 | First enterprise contract that asks for HSM-backed key storage (likely co-incident with SOC2 Type II). Cost when added: $1/key/mo + $0.03/10K ops. |
| Aurora Serverless v2 / Cloud Spanner | Massive Postgres scale | Only if Neon becomes a bottleneck. §1.5 Postgres minimization makes this unlikely. |
| AWS SES | Cheapest transactional email at scale | When monthly email volume passes ~250K (Resend math wins below that). |
| GCP BigQuery / Athena | Huge analytical workloads | When Tinybird bill exceeds ~$1K/mo. |
| AWS Fargate / GCP Cloud Run | Long-running containers | Only if Cloudflare Containers explicitly doesn't fit a real use case. |
| AWS HSM / FedRAMP-grade services | Heavy compliance (HIPAA strict, PCI Level 1, FedRAMP) | If P-1 customer discovery reveals an ICP in healthcare/finance/government, this changes the cloud decision wholesale. Re-evaluate then. |

**Each trigger is a clean signal, not a guess.** We don't pre-pay for AWS/GCP "in case." We add the specific service when the specific condition fires.

### The Bun ↔ Workers constraint

Workers run on V8 with a partial Node compat shim, not Bun. The plan's "Bun + Hono" choice must be parsed as:
- **Local dev + tests: Bun** (fast, matches monorepo)
- **Prod: Cloudflare Workers**
- **Library selection rule from day 1: Workers-compatible variants** — `drizzle-orm` ✓, `@neondatabase/serverless` (not `pg`) ✓, `@upstash/redis` REST (not `ioredis`) ✓, `stripe` ✓, `@workos-inc/node` ✓
- **CI gate:** every PR runs `wrangler deploy --dry-run` to catch Workers-incompatible imports before they land

This is a constraint, not a problem — every package we already need has a Workers-compatible variant.

### V1 cost projection at ~1K MAU paid beta

Fixed monthly: **~$15–60** (Workers $5 + Upstash $10–30 + Tinybird $0–25 + everything else free-tier). Plus Stripe % of revenue. The §2.13 cost-coverage invariants hold at this stack — per-free-user marginal cost stays sub-penny.

### What the original CEO panel review got right, refined

The CEO reviewer pushed "buy boring stuff" and listed AWS/GCP services among the "boring stuff." That framing was directionally correct but assumed a one-cloud answer. The actual answer is **Cloudflare for everything Cloudflare does well, three best-of-breed vendors for the gaps**, and AWS/GCP only on explicit triggers. This is *more* aggressive about not-building-undifferentiated-infrastructure than the original "use AWS" framing would have been, because Workers + Pages + Hyperdrive eliminate even more glue code than EC2 + RDS + ElastiCache would have.

## 1.8 Observability graduated by paying-customer tier

**Trigger:** User: "Evaluate observability and monitoring needs. We don't need them when we have no users, but will need them as soon as there are paying customers."

**Core principle:** don't pay for observability before there's anything to observe — but two things must be wired from day 1 because retrofitting them is painful: **error tracking** and **structured-logging discipline with `account_id` / `request_id` / `trace_id` on every log line**.

**Decision: four tiers, each with a clean trigger.**

### Tier 0 — Day 1 ($0)

Wire these in P0 before any other observability tooling. Cost is zero; the value is making the *next* tier's investment effective.

- **Sentry free tier** (5K errors/mo) — Workers integration is mature; source maps work; PII redaction; PagerDuty/Slack integration when needed. Catches every production exception with stack + context.
- **Cloudflare Logpush → Axiom** — already in stack for audit log. Add request logs to the same pipe.
- **Structured-logging discipline** — every log line carries `account_id`, `request_id`, `trace_id`. Enforced by a logger wrapper, not policy.
- **Cloudflare Workers Analytics** (free, built-in) — RED metrics per route (request count, error rate, p50/p95/p99 latency, CPU time) with no instrumentation.
- **`/v1/health` synthetic Cron Worker** — every minute, exercises auth + bucket check + Tinybird ingest + AI Gateway round-trip. Emits structured log; Sentry alerts on N consecutive failures. This single artifact is the highest-leverage monitoring you'll ever build because it exercises every layer in production.

### Tier 1 — First paying customer / paid beta launch (~$20/mo)

Triggered by: first $1 of revenue + the §2.6 P6 status-page commitment.

- **Instatus public status page** ($20/mo) — already in plan
- **Billing-correctness reconciler alerts** — *custom code*, not a vendor purchase. Three loops (already in plan §2.6 P4/P5) get alert routing to Sentry/Slack: (1) Tinybird `UsageEvent` sum vs Redis `bucket_state` drift > 1%; (2) Tinybird sum vs Stripe Meters reported > 0.5%; (3) outbox rows older than 5 minutes unshipped.
- **PostHog free tier** (1M events/mo) — start tracking the §2.6 P0.5 TTF-200 activation metric in a queryable place.
- **Slack incident channel** — Sentry + reconciler alerts → `#noetic-alerts`. Human-eyeball paging until on-call exists.

### Tier 2 — Multiple paying customers, ~10+ ($1K+ MRR) (~$25–75/mo)

Triggered by: an actual on-call rotation forming, or the first "your API is slow" support ticket that's hard to diagnose.

- **Better Stack** ($24/mo, bundles uptime + status + on-call rotations) — can replace Instatus. External probes (a Cloudflare-side outage actually shows up because Better Stack pings from outside CF).
- **Honeycomb free tier** for distributed tracing across Worker → Hyperdrive → Neon, Worker → Upstash, Worker → AI Gateway → upstream. Workers don't have native OpenTelemetry yet, but the integration libs exist.
- **SLO dashboards** — built on Axiom + Cloudflare Analytics, no new vendor. Codify what matters: gateway availability 99.9%, p95 latency <500ms, TTF-200 <60s, bucket-check p99 <10ms, key-verification p99 <5ms.
- **Sentry Team** ($26/mo at ~50K errors/mo) if free tier runs out — only if.

### Tier 3 — Enterprise / SLA commitments ($500–2K/mo)

Triggered by: first enterprise contract with SLA penalty clauses, or SOC2 Type II audit prep.

- **Datadog or Grafana Cloud** ($200–500/mo) — unified observability + APM. Single-pane-of-glass for support + on-call.
- **PagerDuty proper** ($21/user/mo) — when Better Stack on-call isn't enough (multiple rotations, complex escalation).
- **Vanta integration with monitoring** — SOC2 Type II requires alerts on access anomalies and monitoring-coverage attestation.
- **Sentry Performance / APM** — slow-query and trace-rooting at customer-perceived latency.

### Three platform-specific monitoring concerns (codified)

These are unique to a billing+inference platform and don't appear on a generic observability vendor's "what you need" list:

1. **Billing-correctness reconciliation is the #1 incident class.** A silent drift between Redis, Tinybird, and Stripe is a customer-billing dispute waiting to happen. The three reconciler alerts above must fire to a human channel from day 1 of paid beta — cheaper to instrument now than investigate after the fact.
2. **Inference cost tracking even on BYOK.** Customer pays the upstream provider, but we still want per-account token economics for product/eval insight. Emit `model_cost_usd` (from OR/Anthropic usage block) as a `UsageEvent` dimension — costs nothing extra, valuable forever. For the trial-credits pool and managed-inference path, this is real money we must track.
3. **The `/v1/health` synthetic is the SLA evidence record.** It's the artifact pointed at during a customer dispute ("our metrics show 99.94% availability for that period"). Run it from outside Cloudflare in Tier 2+ so a Cloudflare-side outage actually surfaces in our metrics.

### What NOT to do

- No Datadog at v1 — easily $500/mo for one engineer's worth of usage; real value kicks in at Tier 3.
- No custom Prometheus + Grafana on a VPS — more hours maintaining than using.
- No "wire Sentry when something breaks" — it's free; wire day 1.
- No PagerDuty before there's a real on-call rotation — Sentry → Slack → eyeball is fine until ~10 paying customers.

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

Organized by plane. Cloudflare-first; three external vendors fill gaps Cloudflare doesn't cover. See [§1.7](#17-cloudflare-first-cloud-strategy) for the cloud strategy and [§2.14](#214-cloud-architecture) for the layered architecture picture.

### Compute / edge (Cloudflare)

| Layer | Choice | Rationale |
|---|---|---|
| API + inference gateway | **Cloudflare Workers** running `packages/api` (Hono) | Edge-deployed, Hono runs natively, SSE works (30s CPU is CPU-bound, inference is idle-waiting), free DDoS + WAF baked in |
| Local dev runtime | Bun | Fast, matches monorepo; same Hono code runs on Workers |
| Inference upstream wrapper | **Cloudflare AI Gateway** (free) | Caching + provider fallback + real-time logs in front of OR/Anthropic/OAI at no cost |
| Background workers (outbox shipper, billing reporter, reconciler) | **Cloudflare Cron Triggers + Queues** | Cron free with Workers Paid; Queues $0.40/1M ops |
| Dashboard hosting | **Cloudflare Pages** — extend `packages/web` (or split `packages/dashboard`) | Free at our scale; same-domain integration with Workers |
| Object storage (exports, generated reports, eventual audit dumps) | **Cloudflare R2** | Zero egress fees, S3-compatible |
| Postgres connection pooling | **Cloudflare Hyperdrive** | Workers can't hold long-lived Postgres connections; Hyperdrive pools + caches + TLS-terminates |
| DNS / CDN / WAF / Bot management | Cloudflare (already) | Free baseline |
| Secrets storage | **Cloudflare Workers Secrets / Secrets Store** | Sufficient for v1 (one HMAC pepper + handful of vendor tokens); KMS trigger condition documented in §1.7 |

### Data plane (external vendors — Cloudflare doesn't offer)

| Layer | Choice | Rationale |
|---|---|---|
| Relational core (OLTP) | **Neon** + Drizzle — **only** accounts, members, api_keys, buckets-config, billing_period_summary, outbox | Serverless Postgres for Workers; scales to zero; free tier covers v1. See [§1.5](#15-postgres-minimization-directive) for what does *not* go here. |
| Hot-path counters + caches | **Upstash Redis** — bucket_state, key-verification cache, idempotency-key fingerprint, WorkOS membership cache, rate limit, per-key RPS bucket | REST API + pay-per-request fits Workers; atomic Lua/INCRBY (Cloudflare KV can't do this) |
| Usage analytics + time-series | **Tinybird** (or ClickHouse Cloud) | High write volume, append-only, analytical queries |
| Audit log | **Axiom** tagged by `account_id`, shipped from Postgres outbox via Cloudflare Logpush + worker | Append-only, immutable structurally, customer-facing read/export queries Axiom directly |

### Vendor services (managed product, not infrastructure)

| Layer | Choice | Rationale |
|---|---|---|
| Auth | **WorkOS AuthKit** | 1M MAU free; SSO/SCIM on enterprise trigger |
| Billing | **Stripe Billing Meters API** | Current API (legacy metered deprecated) |
| Email | **Resend** | Free 3K/mo, $20/mo for 50K |
| Webhooks (out) | **Svix** when first customer asks | Reliable delivery is a 2-week project we don't need now |
| Inference upstream | **OpenRouter** (default) + direct Anthropic/OAI | One API, normalized streaming; fronted by Cloudflare AI Gateway |

### Application-layer (in-house)

| Layer | Choice | Rationale |
|---|---|---|
| API keys | In-house: HMAC-SHA256 + Workers Secrets pepper + Upstash 60s verification cache | 3–4 day build; no vendor in auth hot path; marginal cost per free user ≈ 0 with cache. See [§1.6](#16-unkey-rejected-in-house-keys--verification-cache) |
| SDK | `@noetic-tools/sdk` thin wrapper | Surfaces trace IDs, ties to `@noetic-tools/core` |

## 2.6 Phased build

Target: paid beta in 6 weeks, one engineer. Realistic: 8 weeks.

### P0 — Foundation (wk 1)
- `packages/api` skeleton (Hono on Workers; Bun for local dev/tests)
- **CI gate from day 1:** every PR runs `wrangler deploy --dry-run` to catch Workers-incompatible imports. Library selection rule: Workers-compatible variants only (`@neondatabase/serverless`, `@upstash/redis` REST, etc.). See [§1.7](#17-cloudflare-first-cloud-strategy).
- Cloudflare account + Workers + Pages + R2 + Hyperdrive provisioned
- Postgres schema on **Neon** (relational core only): `users`, `accounts`, `members`, `api_keys`, `buckets` (config), `billing_period_summary`, `outbox`. Hyperdrive in front.
- Upstash Redis provisioned. `bucket_state` Lua scripts (reserve/settle/release) written and tested
- Axiom workspace provisioned. Logpush → Axiom configured. Outbox-shipper worker scaffold (Postgres outbox → Axiom)
- Tinybird workspace + `UsageEvent` ingest endpoint
- WorkOS AuthKit integration. **WorkOS is source of truth on read path**: 60s TTL membership cache (Upstash), webhooks for cache invalidation only, daily reconciliation cron (Cloudflare Cron Trigger)
- `hasScope()` middleware, default-deny. V1: hardcoded role→scope map
- Account ID in every URL **plus** Postgres RLS or typed `AccountScope` repo guard
- CI cross-tenant pen-test suite (try-to-read-another-tenant)
- **Sentry wired (free tier)** — every Worker exception captured with stack + `account_id` + `request_id` + `trace_id` context
- **Structured-logging discipline** — logger wrapper enforces `account_id` / `request_id` / `trace_id` on every line; Cloudflare Logpush → Axiom configured for request logs (same pipe as audit)
- **`/v1/health` Cron Worker** (1-minute interval) exercising auth + bucket check + Tinybird ingest + AI Gateway round-trip; Sentry alert on N consecutive failures. See [§1.8](#18-observability-graduated-by-paying-customer-tier).

### P0.5 — Time-to-first-token (wk 1, parallel)
- Signup auto-provisions personal Account + default `noetic_test_*` key + trial bucket
- Success screen shows copy-paste `curl` (or BYOK setup + curl)
- Instrument **time-to-first-200** as north-star activation metric
- "Migrating from OpenRouter/OpenAI" landing snippet

### P1 — Account self-serve (wk 2)
- Members list, invite flow, role assignment UI
- **Customer-facing audit log** read + export API
- Outbox-pattern audit on Stripe/WorkOS mutations (no cross-network Postgres tx)

### P2 — API keys (wk 2, ~3–4 days)
- In-house: `noetic_<env>_<24B-base62>`, stored as prefix + HMAC-SHA256 with KMS-pepper, constant-time compare on the HMAC
- **Redis verification cache, 60s TTL** on `(api_key_hash) → {account_id, scopes, status}` — the non-negotiable cost-coverage primitive ([§1.6](#16-unkey-rejected-in-house-keys--verification-cache), [§2.13](#213-cost-coverage-invariants))
- Cache invalidation on revoke + on scope/membership change
- Account-owned by default, `created_by` audit field, rotate-on-offboarding
- Per-key Redis token-bucket RPS limit (free-tier default, paid-tier override)
- **Honor `Idempotency-Key` header** on the inference gateway (24h TTL fingerprint cache, same Redis instance)
- Dashboard UI: create / list / revoke / last-used / RPS-stats

### P3 — BYOK + observability gateway (wk 3–4)
- `@noetic-tools/sdk` wraps the gateway, surfaces trace IDs, integrates with `@noetic-tools/core`
- **Worker → Cloudflare AI Gateway → upstream provider** — AI Gateway adds caching, provider fallback, and real-time logs for free; Worker owns auth + bucket + UsageEvent emission
- **BYOK default**: customer key → forward via AI Gateway to OR/Anthropic/OAI, capture usage from response, emit `UsageEvent` (token counts, model, tool calls, trace ID)
- **Trial credits** path: forward via Noetic's OR account through AI Gateway, cap at $5 lifetime/account, no overage
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
- **Billing-correctness reconciler alerts routed to Sentry + Slack** (see [§1.8](#18-observability-graduated-by-paying-customer-tier)) — three loops: (1) Tinybird `UsageEvent` sum vs Redis `bucket_state` drift > 1%; (2) Tinybird sum vs Stripe Meters reported > 0.5%; (3) outbox rows older than 5min unshipped
- **`model_cost_usd` emitted as a `UsageEvent` dimension** (from upstream usage block) — per-account token economics tracked even on BYOK; the trial-credits pool and managed-inference path depend on it
- **Shadow-billing period** before going live
- **Prepaid credits** as a Tinybird-backed balance ledger — default for new accounts. Postpaid invoicing is enterprise opt-in behind credit check
- Stripe Customer Portal for self-serve subscription management
- Public `/pricing` page + calculator
- Subscription lifecycle: `past_due` → degrade (read-only), not lockout

### P6 — Polish / trust (wk 6+)
- Status page (Instatus, 99.9% target) wired to `/v1/health` Cron Worker output
- **PostHog free tier** wired for TTF-200 activation funnel + signup events
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

### Observability (Tier 0 — see [§1.8](#18-observability-graduated-by-paying-customer-tier))
- Sentry wired (free tier) — every Worker exception with `account_id` / `request_id` / `trace_id` context
- Structured-logging discipline enforced by a logger wrapper; Logpush → Axiom for request logs
- `/v1/health` Cron Worker exercising auth + bucket + Tinybird + AI Gateway every minute
- `model_cost_usd` emitted as `UsageEvent` dimension (tracks economics on BYOK too)

### Process
- 1-page GTM with named ICP and 3+ design partner LOIs gating the build
- Build-vs-buy decisions logged (Stripe Portal, Svix, Tinybird, observability vendors)

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
- ~~**Unkey vs custom keys.**~~ Resolved 2026-06-14: in-house. See [§1.6](#16-unkey-rejected-in-house-keys--verification-cache).
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

## 2.13 Cost-coverage invariants

Architectural constraints, not implementation details. Together they bound the marginal cost of a free user to fractions of a cent per active month, regardless of how heavily they use the platform. Violating any of these requires an explicit decision-history entry.

1. **Redis verification cache (60s TTL) sits in front of every auth check.** API-key lookups, scope resolution, and WorkOS membership all hit cache first. Cold-path Postgres / WorkOS calls scale with *unique active keys per minute*, not request rate. A user hammering at 1000 RPS produces ~1 cold lookup/minute, not 60K.
2. **Per-key Redis token-bucket RPS limit.** Free tier: 5 RPS default. Paid tiers override upward. Hard ceiling — no overage path. Bounds worst-case auth-check load per key and protects against runaway agents independently of the bucket check.
3. **Free-tier daily request cap, hard-limited.** E.g. 10K agent-runs/account/day, enforced at the gateway. Also serves as runaway-agent protection (PM's concern in panel review). A free account cannot generate unbounded billable activity.
4. **BYOK by default eliminates inference cost.** Customer pays OR/Anthropic/OAI directly. The biggest variable cost in the system is not on our P&L for the majority of users.
5. **Trial credits pool hard-capped at $5/account lifetime.** The only $$ we spend per free user, bounded by design. Funded out of Noetic's OR account; hits cap → "add your key to continue." No overage path.
6. **All hot-path counters and caches share one Upstash Redis instance.** Bucket state, idempotency cache, membership cache, key verification cache, rate limit buckets, RPS limits. Fixed monthly cost (~$10–30/mo) independent of user count. Per-user marginal cost is Redis-ops × Upstash-per-op pricing, which at the cache hit rates above is sub-penny.

**Net result:** for a 10K-signup, 1K-active free cohort with the invariants in place, all-in cost-to-serve free users is **single-digit dollars/month** (Upstash + a few thousand Tinybird events + the $5 trial credit pool drawn down by a small fraction of accounts).

**These invariants survive vendor swaps.** Whether keys are in-house or Unkey, whether analytics is Tinybird or ClickHouse, whether OLTP is Neon or Supabase — the cost-coverage shape is the same as long as the cache layer + RPS limits + daily caps + BYOK default + bounded trial pool are intact.

## 2.14 Cloud architecture

Cloudflare-first; three external vendors fill data-plane gaps Cloudflare doesn't offer. See [§1.7](#17-cloudflare-first-cloud-strategy) for the decision rationale and AWS/GCP trigger conditions.

### Layered picture

```
                          ┌──────────────────────────────────────┐
                          │  Cloudflare DNS / CDN / WAF / Bot    │
                          └──────────────────────────────────────┘
                                            │
        ┌───────────────────────────────────┼────────────────────────────────┐
        │                                   │                                │
        ▼                                   ▼                                ▼
  ┌──────────┐                  ┌──────────────────────┐         ┌──────────────────┐
  │  Pages   │                  │  Workers (Hono API)  │         │  AI Gateway      │
  │ packages │                  │  - hasScope          │         │  cache/fallback  │
  │  /web    │                  │  - bucket reserve    │ ───┐    │  ───────────────│
  └──────────┘                  │  - UsageEvent emit   │    │    │  to OR / Anth /  │
                                │  - SSE proxy         │    │    │  OAI upstream    │
                                └──────────────────────┘    │    └──────────────────┘
                                            │               │
       ┌────────────────────┬───────────────┼──────────────┬┴────────────────┐
       ▼                    ▼               ▼              ▼                 ▼
 ┌──────────┐        ┌──────────┐    ┌──────────┐   ┌──────────────┐  ┌──────────┐
 │Hyperdrive│        │ Upstash  │    │ Tinybird │   │ Logpush →    │  │ Cron     │
 │   pool   │        │  Redis   │    │ UsageEvt │   │ Axiom        │  │ Triggers │
 └────┬─────┘        │ bucket_  │    │ ingest   │   │ audit shipper│  │ + Queues │
      │              │ state,   │    └──────────┘   └──────────────┘  └──────────┘
      ▼              │ caches,  │
 ┌──────────┐        │ RPS,     │
 │  Neon    │        │ idemp.   │
 │ Postgres │        └──────────┘
 │  OLTP    │
 │  core    │
 └──────────┘                                        ┌──────────────┐
                                                     │      R2      │
                                                     │ exports/blobs│
                                                     └──────────────┘

  External SaaS APIs called from Workers:
  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
  │WorkOS  │  │Stripe  │  │Resend  │  │OpenRtr │  │Anthropic│  │OpenAI  │
  │(auth)  │  │(billing│  │(email) │  │(infer) │  │(infer)  │  │(infer) │
  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘
```

### Read path (typical inference request)

1. Client → Cloudflare edge (TLS, WAF, DDoS)
2. → Worker: parse `Authorization: Bearer noetic_live_*`
3. → Upstash: `GET key:<prefix>` (cache hit ~99% after warm-up; cold → Neon via Hyperdrive)
4. → Upstash Lua: `reserve(account, metric, worst_case_cost)` — atomic, single round-trip
5. → AI Gateway → upstream provider (BYOK customer's key or trial pool); SSE streamed back to client
6. On stream completion → Upstash Lua: `settle(account, metric, actual)` (release reservation, increment used)
7. → Tinybird: emit `UsageEvent` (fire-and-forget POST; idempotency key dedupes retries)
8. (No Postgres hit on the inference hot path. None.)

### Write path (typical mutation, e.g. revoke key)

1. Worker: `hasScope(member, 'keys:revoke', account)` — Upstash cache hit
2. Begin Postgres tx (via Hyperdrive): update `api_keys.status = 'revoked'`, insert into `outbox`
3. Commit tx
4. Worker: invalidate Upstash key-verification cache for that key prefix
5. Cron-triggered outbox shipper picks up the outbox row, ships audit event to Axiom, marks row done

### When to add AWS or GCP

Each has a clean trigger condition; **don't pre-pay**:

| Trigger | Add |
|---|---|
| First enterprise contract requiring HSM-backed key storage | AWS KMS (or GCP Cloud KMS) for envelope encryption of the HMAC pepper + future per-tenant keys |
| Healthcare / finance / FedRAMP ICP discovered in P-1 | Reconsider cloud wholesale — AWS likely wins for compliance surface |
| Tinybird monthly bill exceeds ~$1K | GCP BigQuery or AWS Athena evaluation |
| Email volume passes ~250K/mo | AWS SES |
| Cloudflare Containers explicitly cannot fit a long-running workload | AWS Fargate or GCP Cloud Run for that one workload |
| Neon hits its scaling ceiling | Aurora Serverless v2 or Cloud Spanner — but §1.5 Postgres minimization makes this years out |

**No speculative AWS account, no speculative GCP project.** Add the specific service when its trigger fires.

### Constraints this architecture imposes

- **Library selection rule:** every dependency that talks to Postgres, Redis, or makes outbound HTTP must work in Workers (V8 + partial Node compat). CI enforces with `wrangler deploy --dry-run` on every PR.
- **No long-held connections.** Postgres → Hyperdrive. Redis → REST (Upstash). External APIs → fetch().
- **No `fs`, no `child_process`, no Node-only globals.** If a tool needs those, it doesn't run in the Worker — it runs as a Queue consumer in a separate Worker, or as a Cloudflare Container (if/when needed).
- **CPU time discipline.** Per-request CPU budget on Workers Paid is 30s. Compute-heavy work (e.g. cost reconciliation over a day's events) runs in a Cron-triggered Worker or as a Queue consumer that fan-outs.

## 2.15 Observability & monitoring

Graduated by paying-customer tier. Decision rationale in [§1.8](#18-observability-graduated-by-paying-customer-tier); this section is the operational state.

### Tier 0 — Day 1 (always-on, $0)

Wired in P0 before any paid observability tool:

| Capability | Implementation |
|---|---|
| Error tracking | **Sentry free tier** — captures every Worker exception with `account_id` / `request_id` / `trace_id` context, source-mapped stack |
| Request logs | **Cloudflare Logpush → Axiom** (same pipe as audit) — structured-logging discipline enforced by a logger wrapper |
| RED metrics per route | **Cloudflare Workers Analytics** (built-in) — request count, error rate, CPU time, p50/p95/p99 latency |
| Synthetic uptime | **`/v1/health` Cron Worker** — every minute exercises auth → bucket check → Tinybird ingest → AI Gateway round-trip; Sentry alert on N consecutive failures |
| Cost-economics tracking | `model_cost_usd` emitted as `UsageEvent` dimension from upstream usage block — per-account token economics tracked even on BYOK |

### Tier 1 — Paid-beta launch (~$20/mo)

Triggered by: first $1 of revenue.

| Capability | Implementation |
|---|---|
| Public status page | **Instatus** ($20/mo) wired to `/v1/health` Cron output |
| Billing-correctness alerts | *Custom code, no vendor*: three reconciler loops route to Sentry + Slack — (1) Tinybird sum vs Redis `bucket_state` drift > 1%; (2) Tinybird sum vs Stripe Meters reported > 0.5%; (3) outbox rows older than 5min unshipped |
| Activation analytics | **PostHog free tier** (1M events/mo) — TTF-200 funnel + signup events queryable |
| Incident channel | `#noetic-alerts` Slack — Sentry + reconciler alerts → human eyeball |

### Tier 2 — ~10+ paying customers ($1K+ MRR) (~$25–75/mo)

Triggered by: actual on-call rotation forming, or the first "your API is slow" support ticket hard to diagnose.

| Capability | Implementation |
|---|---|
| External uptime + on-call | **Better Stack** ($24/mo) — uptime + status page + on-call rotations bundled; can replace Instatus. Probes from outside Cloudflare so CF-side outages surface |
| Distributed tracing | **Honeycomb free tier** — Worker → Hyperdrive → Neon, Worker → Upstash, Worker → AI Gateway → upstream |
| SLO dashboards | Built on Axiom + Cloudflare Analytics, no new vendor. SLOs codified: gateway availability 99.9%, p95 latency <500ms, TTF-200 <60s, bucket-check p99 <10ms, key-verification p99 <5ms |
| Error volume | **Sentry Team** ($26/mo) only if free tier exhausted at ~50K errors/mo |

### Tier 3 — Enterprise / SLA commitments ($500–2K/mo)

Triggered by: first enterprise contract with SLA penalty clauses, or SOC2 Type II audit prep.

| Capability | Implementation |
|---|---|
| Unified observability + APM | **Datadog** or **Grafana Cloud** ($200–500/mo) — single-pane-of-glass for support + on-call |
| Paging | **PagerDuty** ($21/user/mo) — multiple rotations, complex escalation when Better Stack on-call isn't enough |
| SOC2 monitoring evidence | **Vanta integration** (bundled with SOC2 work) — access-anomaly alerts + monitoring-coverage attestation |
| APM / profiling | Sentry Performance or Datadog APM — slow-query rooting at customer-perceived latency |

### Three platform-specific monitoring concerns (codified)

These are unique to a billing+inference platform; don't appear on generic-vendor checklists:

1. **Billing-correctness reconciliation is the #1 incident class.** Silent drift between Redis, Tinybird, and Stripe → customer-billing dispute waiting to happen. The three reconciler alerts above must fire to a human channel from day 1 of paid beta.
2. **Inference cost tracking even on BYOK.** Customer pays upstream, but per-account token economics tracked anyway (trial pool + managed inference need it; product insight always needs it).
3. **`/v1/health` synthetic is SLA evidence.** Pointed at during customer disputes ("our metrics show 99.94% availability for that period"). At Tier 2+, must run from outside Cloudflare.

### What NOT to do (explicit cuts)

- No Datadog at v1 — easily $500/mo for one engineer; real value at Tier 3.
- No custom Prometheus + Grafana on a VPS — more hours maintaining than using.
- No "wire Sentry when something breaks" — it's free; wire day 1.
- No PagerDuty before there's a real on-call rotation — Sentry → Slack → eyeball is fine until ~10 paying customers.

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
| 2026-06-14 | Unkey rejected: in-house API keys (3–4 days) + Redis 60s verification cache. Added §2.13 Cost-coverage invariants (Redis cache + per-key RPS + daily caps + BYOK + bounded trial pool + single Upstash). Resolved §2.11 Unkey-vs-custom open question. | User question on Unkey necessity + free-tier cost coverage |
| 2026-06-14 | Cloudflare-first cloud strategy (§1.7, §2.14): Workers + Pages + R2 + AI Gateway + Hyperdrive + Cron + Queues + Secrets. External vendors for the 3 gaps: Neon (Postgres), Upstash (Redis), Axiom (audit). No AWS or GCP at v1; explicit trigger conditions documented. Bun↔Workers CI gate added to P0 must-gets. | User request: optimize for Cloudflare, fall back to AWS/GCP only on demonstrated need |
| 2026-06-14 | Observability graduated by paying-customer tier (§1.8, §2.15). Tier 0 (day 1, $0): Sentry + structured logs + /v1/health Cron + model_cost_usd dimension. Tier 1 (~$20/mo): Instatus + billing-correctness reconciler alerts + PostHog. Tier 2 (~$25–75): Better Stack + Honeycomb + SLO dashboards. Tier 3 ($500–2K): Datadog/Grafana + PagerDuty + Vanta. Three platform-specific concerns codified (billing-correctness as #1 incident class; BYOK cost tracking; /v1/health as SLA evidence). | User request: evaluate observability needs, gated by paying-customer milestones |
