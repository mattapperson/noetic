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
   - [1.9 Round 2 panel overrides (six decisions + Workers footguns + product additions)](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions)
   - [1.10 Monetization commitment: API + CLI, three commercial models](#110-monetization-commitment-api--cli-three-commercial-models)
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
   - [2.16 Competitive positioning](#216-competitive-positioning)
   - [2.17 Monetization model & tiers](#217-monetization-model--tiers)
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

## 1.9 Round 2 panel overrides (six decisions + Workers footguns + product additions)

**Trigger:** Second-round adversarial panel review (PM + Principal Engineer + CEO advisor), explicitly empowered to challenge prior §1 decisions.

**Headline:** the infra plan is sound, but six prior decisions warrant override, ~10 Workers-specific footguns need correction, and three product gaps (eval surface, competitive frame, BYOK trust model) need to ship in v1, not v2.

### Six decision overrides

**1. Authoritative bucket counter: Upstash Redis → Cloudflare Durable Objects** *(Engineer, high conviction; no counter-position)*

Scalar `reserved` in Upstash leaks under Worker timeouts, client disconnects, and upstream 5xx because there is no per-reservation TTL. The 5-min reconciler diffs `used` (Tinybird), not `reserved` (Redis), so leaks never surface until hard caps trip seemingly at random. Upstash REST on the synchronous critical path is also an availability cliff with no fallback (their outage = our outage, violating the 99.9% commitment).

**Switch authoritative `bucket_state` to a Durable Object per `(account_id, metric, period)`.** Reservations become per-id records with TTL alarms; settle deletes the record and applies actuals to `used`; alarms sweep expired reservations. Reconciler computes `reserved = SUM(active reservations)`. Strongly-consistent atomic ops co-located with the Worker, no REST hop, no separate-vendor outage. Upstash retained for eventually-consistent caches only (membership, key-verification cache hint, idempotency fingerprint, RPS buckets). The §1.7 dismissal ("different programming model") was wrong — it's one afternoon of reading.

**2. P-1 gate: 1-week checklist → 3-week hard gate with kill criteria** *(PM + CEO, both high conviction)*

§2.3 was 6 unowned bullets with §4 explicitly permitting parallel P0. Two senior reviewers independently called this fatal *after* the plan had a full round to fix it. New shape:

- **Pre-call artifacts** (built before any P-1 call): written pricing hypothesis with 3 concrete tier-shape variants; live static `/pricing` page reflecting them; "Switching from LangSmith" landing page; competitive teardown table.
- **Dual cohort, 8 calls each**: developer/BYOK vs non-developer/managed.
- **Pass criteria**: ≥3 *written* LOIs at a stated price + ≥8/15 calls answer "I would paste my key IF [X]" with [X] captured verbatim. Verbal LOIs do not count.
- **No parallel P0 build.** P0 starts when P-1 passes.
- **Fail → reposition or pause.** The likely reposition is managed inference for non-developer ICP (i.e., the §1.4 hedge becomes the real product).

**3. §1.4 BYOK-vs-managed hedge → commit to ONE path after P-1** *(CEO, high conviction)*

The hedge is "operationally fictional." BYOK and managed are different stacks, fraud surfaces, brand positions. You cannot pivot mid-build. The dual-cohort P-1 picks the ICP; the loser becomes a separate plan if it wins later. After P-1, one path, one plan.

**4. Trial pool: $5 any-model → $20 cheap-cached models, gated identity** *(PM + CEO)*

PM: $5 ≈ one mid-size Sonnet conversation, not enough to evaluate the framework. CEO: $5 × 1000 throwaway emails = $5K loss + viral "free Claude tokens" HN post. Fix solves both:

- $20/account lifetime trial pool
- Default to cheap-cached models (Haiku / 4o-mini); premium models require BYOK
- Eligibility gate: verified business email **or** phone **or** GitHub ≥30 days old

**5. SOC2 evidence collection: conditional → unconditional in P0** *(CEO, significant conviction)*

Asymmetric cost. Vanta/Drata = single-digit thousands to start. SOC2 Type II is 6–12 months — starting in month 3 forfeits Q1 2027 enterprise pipeline. The audit log, access reviews, and change management we're already building *are* the evidence. Start unconditionally in P0.

**6. HMAC pepper: unversioned → `{pepper_version, hmac}` from day 1** *(Engineer)*

First pepper rotation (employee departure, suspected leak, SOC2 control evidence) under the unversioned spec = forced re-HMAC of every key. Day-1 hedge is one extra Workers Secret. Cost at 50K keys is a migration project. Store `pepper_v1`, `pepper_v2` as separate Workers Secrets; verifier tries the key's tagged version; rotation re-HMACs lazily on next use or in batch.

### Workers-specific correctness corrections (Engineer, all adopted)

| Footgun | Fix |
|---|---|
| Hyperdrive caches queries by default; a cached `SELECT FROM api_keys WHERE prefix = ?` honors a revoked key for the cache TTL | Disable Hyperdrive query caching for `api_keys`, `members`, and any authz-sensitive table. Pooling stays on; caching is per-statement. |
| UsageEvent fire-and-forget POST to Tinybird contradicts "event-sourced billing source of truth" — Workers + public internet drops events; idempotency only dedupes retries that don't happen | Route UsageEvent emission through **Cloudflare Queues**. Worker enqueues at settle time; Queue consumer ships to Tinybird with retries + DLQ. ~50ms added latency; billing source of truth is now durable. |
| Silent `max_tokens` clamp produces non-deterministic eval outputs | **Refuse with 402/429 + `X-Remaining-Budget` header.** Silent clamp forbidden. |
| Idempotency-Key spec only handles "we saw this key," not in-flight replays | State machine: `(account_id, idempotency_key) → {state: in_flight | succeeded | failed, response_ref?}`. In-flight = block-and-wait, not race. Streaming responses stored in R2. |
| WorkOS 60s membership cache → fired admin can revoke production keys during eviction window | Define `SENSITIVE_SCOPES` (`keys:revoke`, `members:remove`, `billing:*`). Bypass cache for these; read from WorkOS or the strictly-consistent Postgres mirror. |
| Tinybird PII validation at producer is insufficient — a future sub-harness path could smuggle prompts into `dims.error_message` | Tinybird-side defense-in-depth: materialized view with regex/length checks; reject or quarantine writes exceeding thresholds. |
| Audit log via Postgres outbox + Cron = 60s+ lag under burst | Direct enqueue to Cloudflare Queue at commit time; consumer ships to Axiom. Drop Postgres outbox in v1. |
| `/v1/health` self-ping is not credible SLA evidence in a customer dispute | Add **UptimeRobot free tier** external probe at Tier 0 — independent attestation. |
| Postgres RLS + Hyperdrive prepared-statement cache is a documented footgun (RLS only works in explicit txs; cached prepared statements bypass) | Pick **typed `AccountScope` repo** only. Drop "RLS or AccountScope" ambiguity. |
| Free-tier daily cap folded into bucket Lua → hot-key behavior at 00:00 UTC across all accounts | Either shard `period_start` into the key (`account:metric:YYYY-MM-DD`) or use Workers Analytics request count for the daily cap. |
| Stripe Meter period-boundary misallocation (60s micro-batch + Stripe eventual consistency + `ts` near rollover) | 5-min grace window around rollover; stamp `period_anchor`; reconciler runs +10min after every rollover; manual replay tool built **before first paid customer**. |

### Product additions (PM, all strongly supported)

- **Add P3.5 "Eval surface" parallel with P3.** The moat (eval/GEPA) gets zero engineer-weeks in the current §2.6 — exact same flag CEO raised in round 1. P3.5 ships: in-product scorer definition, eval scores per trace, one GEPA optimization run visible end-to-end. Without this v1 has no answer to "why not LangSmith?"
- **Eval/GEPA compute plane separate from Workers.** Won't fit 30s CPU cap. Cloudflare Containers (GA) or small Fly.io worker pool.
- **BYOK key-handling spec including async/SDK-side mode.** §2.2 strategic posture #1 says "we forward your key" — that's the activation moment with zero product detail. Add: encrypted at rest with per-tenant DEK; write-only via dashboard; scope-restriction UI; rotation flow; **and a second mode where Noetic never sees the upstream key — the SDK calls upstream directly and POSTs the trace to Noetic async**. Helicone has this; removes the largest trust objection.
- **Onboarding success-screen artifact**: 5-line `@noetic-tools/sdk` snippet running a typed agent → trace tree visible in dashboard within seconds + one eval score. Not a `curl`.
- **Migration page**: "Switching from LangSmith" replaces "Migrating from OpenRouter/OpenAI" as primary. The switching customer is on LangSmith paying $39/mo, not on OR/OAI.
- **Competitive positioning section** (new §2.16): name the 3–4 direct comps (LangSmith, Braintrust, Helicone, Langfuse), the 1–2 wedge claims, and the metric we're undeniably better on.
- **Free-tier shape locked**: 1,000 agent-runs/mo + 500 eval scores/mo + 30-day trace retention. (Replaces the inconsistent §2.13 invariant 3 "10K agent-runs/day".)

### CEO additions

- **EU AI Act specialist call** before P0 ($500–800). Noetic's harness/memory/evaluator likely classifies as "provider of a general-purpose AI system" under Articles 53/55 — documentation/log-retention/transparency obligations independent of BYOK. If GPAI provider documentation is required, it's a 6–12 week project, not P6 polish.
- **Customer support + on-call as a P0 line item.** Plain or email-only initially; ~20% of one engineer once first 5 paying customers exist; Resend onboarding-email lifecycle (day 1 / 7 / 30) — Resend is in stack but unused for lifecycle.
- **AI Gateway abstraction with exit trigger.** AI Gateway is free *today* (likely monetizing 2026–27). Abstract behind `forwardToUpstream(provider, request)`. Documented exit: if pricing changes or managed inference needs to own caching/fallback as features, rip + replace with direct provider SDK + own cache (~1 week).
- **Audit log retention SLA: 7 years.** Axiom hot 90 days; nightly parquet → R2 archive job built in P0 (~1 day, ~$5/mo). Without this, first GDPR/SOC2 ask is a fire drill.
- **Cloudflare exit playbook** (2 pages in §2.14): cost/timeline to move API tier to Fly.io / Railway. Acquirer and Series A investor diligence will ask about 11-product Cloudflare concentration.
- **Schedule rebaseline: 12 weeks 1-engineer OR 8 weeks 2-engineer.** Move P6 (status page polish, Svix, DPA, deletion state machine) out of paid-beta into "first paying customer + 30 days." The "8 weeks/1 engineer" headline is no longer honest after the round-2 additions.

### Decisions explicitly held (panel preserved these)

- §1.4 BYOK-default as the *primary* path (the commitment-to-one-ICP after P-1 is the change; not BYOK itself)
- §1.5 Postgres minimization rule
- §1.6 in-house API keys (but rebaseline to ~2 weeks including dashboard UX, not 3–4 days)
- §1.7 Cloudflare-first (with exit playbook + AI Gateway abstraction added)
- §1.8 observability tiered approach (but cut Tier 2/3 detail from this plan; move to separate roadmap note)
- Event-sourced UsageEvent, Stripe Billing Meters with deterministic idempotency, cost-coverage invariants — "founder-grade thinking"

### Items killed

- §4 "P0 can start in parallel" — no parallel P0 before P-1 gate passes
- In-memory soft pre-filter on bucket checks (DO atomic op is fast enough)
- Three reconciler loops with separate thresholds from day 1 (start with one; tune in spec)
- Postgres outbox + Cron audit shipper (replaced by direct Queue enqueue at commit)
- Honeycomb at Tier 2 (Workers Analytics + Sentry breadcrumbs suffice through ~50 customers)
- S3–S7 spec scaffolding before P-1 closes (write S1 + S2 only; collapse S6+S7; defer S5 if pricing comes back per-seat)
- Postgres RLS (typed `AccountScope` only)
- Silent `max_tokens` clamp
- "Migrating from OpenRouter/OpenAI" as primary migration landing (replace with "Switching from LangSmith")
- §1.4 hedge framing (split decisively after P-1 dual-cohort)

### Open questions resolved by this entry

- **Free-tier shape** (§2.11): locked at 1,000 agent-runs/mo + 500 eval scores/mo + 30-day trace retention
- **Trial credits funding** (§2.11): $20/account cheap-cached + gating (above)
- **Pricing units**: still open, but constrained — P-1 tests three written hypotheses on a live `/pricing` page (per-seat, per-agent-run, hybrid), and customers react to numbers rather than generating them.

## 1.10 Monetization commitment: API + CLI, three commercial models

**Trigger:** User commitment: "Initial monetization routes will be general API access and then paid CLI features. Options for subscription/seat tiers, non-subscription pay-for-usage, plus enterprise."

**This resolves the §2.11 "pricing units" open question** that the round-2 panel left constrained-but-open: all three pricing models coexist from day 1, customers pick.

### Two product surfaces, monetized in sequence

1. **General API access** (primary): gateway + traces + memory + eval/GEPA. Monetized at launch.
2. **Paid CLI features** (secondary): GEPA optimization, remote eval datasets, sub-harness commands, multi-account workspace switching, plugin system. Brings `@noetic-tools/cli` into the paid surface; OSS framework remains free.

### Three commercial models coexisting

- **Subscription / seat tiers** (Developer single-seat, Team per-seat) — bundled quotas + CLI Pro unlock
- **Pay-as-you-go** — pure usage metering, no commitment, no CLI Pro (or as a $9/mo add-on per user, accepted arbitrage with Team tier)
- **Enterprise** — custom contract: SSO/SCIM, SOC2 evidence, custom quotas, support SLA, optional managed inference, optional single-tenant

**Hybrid is real**: subscription tiers can have overage that bills through the same Stripe Meters as PAYG. Customer on Team plan exceeds bundled quota → metered overage. Same primitives serve both.

### Locked tier shape (introductory + steady-state)

| Tier | Model | Introductory | **Steady-state** | Includes |
|---|---|---|---|---|
| **Free** | n/a | $0 | $0 | 1K agent-runs/mo, 500 eval scores, 30d trace retention, 1 seat, OSS CLI only, $20 BYOK trial pool |
| **Developer** | Subscription, 1 seat | $10/mo | **$19/mo** | Bundled quotas (10–20K runs, 5K evals, 90d retention), CLI Pro, BYOK |
| **Team** | Subscription, base + per-seat | $30/mo + $10/seat | **$49/mo + $15/seat** | Shared org quotas, CLI Pro per seat, role-based access, audit log export, SOC2 evidence access |
| **Pay-as-you-go** | Pure usage | TBD by P-1 | **$0.008/agent-run + $0.03/eval-score** | No CLI Pro by default; $19/mo per-user CLI Pro add-on optional |
| **Enterprise** | Custom contract | Quote | Quote (typically $500+/mo) | SSO/SCIM, SOC2 evidence, custom quotas, support SLA, optional managed inference, optional single-tenant |

**Introductory pricing applies for the first 6 months of paid beta** (or first 100 paying customers, whichever comes later). Existing customers grandfather in at intro pricing for 12 months from signup; after that, migrate to steady-state on next billing cycle with 60-day notice.

### Unit-economics check (why steady-state is "operating in the black")

BYOK means we don't carry inference cost — the most expensive variable in the comp set. Our variable costs are tiny:

| Cost | Per active Developer customer/mo |
|---|---|
| Stripe fees (2.9% + $0.30 per charge) | $0.85 on $19 |
| Tinybird ingest (≈40K UsageEvents) | <$0.10 |
| Upstash ops + DO time + R2 storage | <$0.10 |
| Workers compute | <$0.05 |
| Fixed-cost amortization (Workers $5/mo + Tinybird $25/mo + Instatus $20/mo + Vanta annualized) | ~$1/customer at 50 customers, ~$0.20 at 250 |
| **Total variable + amortized fixed** | **~$2/mo at scale** |
| **Gross margin on Developer** | **~89%** ($17/$19) |

Even at introductory $10/mo, gross margin is ~80% — already in the black at unit level. Steady-state simply captures more of the value we're already delivering, rather than fixing a loss-leading anchor.

### Steady-state competitive frame

| Comparison | LangSmith | **Noetic steady-state** | Delta |
|---|---|---|---|
| Single-developer pricing | Developer $39/mo | **Developer $19/mo** | **$20/mo cheaper** |
| 5-seat team pricing | Plus $79/mo (5 seats) | **Team $49 + 5×$15 = $124/mo** | $45/mo more BUT includes SOC2 evidence + audit export (LangSmith Enterprise-only) |
| 10-seat team pricing | Plus capped, push to Enterprise | **Team $49 + 10×$15 = $199/mo** | Predictable; LangSmith Enterprise typically $500–2K |
| Per-event PAYG | not offered | **$0.008/run + $0.03/eval** | Cheaper than Helicone Growth at hobby-scale; LangSmith has no equivalent |

**Developer-tier wedge holds at steady-state**: $20/mo cheaper than LangSmith with strictly more features (GEPA, sub-harness CLI, 90d retention vs 14d). Team tier no longer price-matches LangSmith Plus but justifies the gap with SOC2 features Plus doesn't offer; price-positions vs LangSmith Enterprise where Noetic Team is dramatically cheaper.

### Metering anchors (what gets billed)

- **`agent-runs`** — pay-per-thing-the-agent-did. Customer-value-aligned.
- **`eval-scores`** — pay-per-scored-run. Tracks the moat.
- **Tokens are NOT a billable unit** — keeps the [§1.4](#14-openrouter-pragmatism-debate) BYOK posture intact (we don't bill for upstream cost; customer pays provider directly).
- **Trace storage beyond retention window** — possible third meter later, deferred.

### CLI Pro feature cut (initial, will adjust)

**OSS (free, always)** — `noetic run`, basic step primitives, local eval, project init, all framework imports
**CLI Pro (paid)** — `noetic optimize` (GEPA), `noetic eval --remote` (cloud datasets), sub-harness commands (`noetic claude-code`, `noetic codex`, `noetic opencode`, `noetic pi`), multi-account workspace switching, plugin system installs, project sync to cloud

**Entitlement mechanism**: API key carries an `entitlements` claim cached in Upstash alongside scopes. CLI checks entitlement on protected commands. **Offline grace period: 7 days** — CLI keeps last-known entitlements signed locally so airplane mode works.

### Implementation impact on the plan

- **§2.11 "Pricing units" open question: resolved by this entry.**
- **§3 S5 Billing** can no longer collapse to seat-counting if P-1 returned that. Stripe schema supports all three day 1. Adds ~1 week to P5.
- **§3 S3 API Keys** gain an `entitlements` dimension alongside scopes. Already designed scope-bearing; one more field.
- **`packages/cli`** gains: license-check middleware on protected commands, offline grace with signed cache, entitlement-aware error messages ("upgrade to Developer to use `noetic optimize`").
- **§2.3 P-1** shifts from "should we tier?" to "which tier do you fit?" with actual numbers on a live `/pricing` page.
- **§2.16 competitive positioning** table is now anchored to real numbers, not hypothesis ranges.

### Accepted arbitrage

PAYG without seat fee + $9/mo CLI Pro add-on per user creates an arbitrage vs Team. A team could give every dev a free PAYG account + the add-on instead of paying $30 + $10/seat. **Accepted for v1.** The meters still bill for usage, and teams that need centralized admin/audit will pay for Team regardless. Sharper instrument than locking it down.

---

# Current plan

## 2.1 North star

Noetic's product is the **typed agent framework + memory layers + eval/GEPA optimization**. The SaaS exists to monetize that, not to resell tokens. Inference is a feature; the framework + eval loop is the moat.

**One-line pitch:** "Bring your OpenRouter/Anthropic/OpenAI key. Get a typed agent framework with traces tied to every run, eval scoring, prompt versioning, and memory layers — billed per seat / per agent-run / per eval, not per token."

## 2.2 Strategic posture

The load-bearing decisions. Change these → re-litigate the whole plan.

1. **BYOK-default for inference (primary v1 path).** Customers paste their own OR/Anthropic/OAI key. We forward, we trace, we don't bill for tokens. Removes the margin trap, fraud/chargeback exposure, GDPR-processor risk, and merchant-of-record problem. After P-1 dual-cohort (see §2.3), this commitment becomes singular — managed inference, if it wins, gets a separate plan. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
2. **Trial credits pool**: $20/account lifetime, defaulted to cheap-cached models (Haiku / 4o-mini), gated on verified business email **or** phone **or** GitHub ≥30 days old. Premium models require BYOK. Hits cap → "add your key to continue."
3. **Managed inference** ships as a feature flag for explicit design partners only — gated behind CC + manual review + hard caps. Not a v1 monetization path.
4. **OR as upstream is fine.** Model catalog, normalized streaming, one-vendor billing on our side. Vendor choice, not business model.
5. **Event-sourced usage** for everything billable. Buckets, invoices, dashboards are all read models computed from immutable `UsageEvent` rows.
6. **Buy the boring stuff.** WorkOS (auth), Stripe Billing Meters (billing), Tinybird (usage analytics), Upstash Redis (eventually-consistent caches only), Axiom (audit log shipping), Svix (webhooks when needed), UptimeRobot (external probe), Vanta/Drata (SOC2 evidence). Custom code budget = the Noetic value layer.
7. **Postgres only when strictly relational.** Postgres holds accounts/members/api_keys/buckets-config/billing_period_summary — the small, joined, transactional core. Authoritative counters live in Durable Objects; caches in Upstash; analytics in Tinybird; audit in Axiom (shipped via Queue). See [§1.5](#15-postgres-minimization-directive) and [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).

## 2.3 P-1 — Pre-build (3-week hard gate, no code)

**Gates the build. No parallel P0.** See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions) for rationale.

### Pre-call artifacts (built before any P-1 call)

- [ ] Live static `/pricing` page reflecting the **locked tier shape** from [§2.17](#217-monetization-model--tiers) — Developer $10/mo, Team $30 + $10/seat, PAYG metered, Enterprise quote. PAYG $/run + $/eval-score numbers tested as variants.
- [ ] "Switching from LangSmith" landing page — side-by-side trace UI screenshots, pricing comparison at typical volumes, one-line `@noetic-tools/sdk` shim that ingests LangSmith-format traces during transition
- [ ] Competitive teardown table (LangSmith / Braintrust / Helicone / Langfuse — pricing, free-tier shape, eval workflow) on `/pricing` and in [§2.16](#216-competitive-positioning)
- [ ] 1-page GTM: named ICP, wedge, conversion event, channel
- [ ] 1-hour EU AI Act specialist call ($500–800) — classify Noetic under GPAI provider obligations for both BYOK and managed paths

### Dual cohort discovery (16 calls)

- [ ] **8 developer/BYOK calls** — validate "BYOK + traces + eval" is the pull
- [ ] **8 non-developer/managed calls** — validate the managed-inference hedge if it has demand

### Pass criteria (hard gate)

- [ ] ≥3 **written** LOIs at a stated price (verbal LOIs do not count)
- [ ] ≥8 of 15 calls answer "I would paste my key IF [X]" with [X] captured verbatim (the [X] is the onboarding spec)
- [ ] **One ICP committed.** No hedge into P0. If managed inference wins, that becomes a separate plan.

### Fail → reposition or pause

If <3 LOIs or <8/15 trust validation: reposition (likely managed inference for non-developer ICP) or pause until pain materializes. Do not "build anyway."

### Independent of P-1 outcome, kicked off in parallel (not gating)

- [ ] Vanta or Drata workspace provisioned (SOC2 evidence collection from day 1; see [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions) override 5)
- [ ] EU AI Act classification documented based on specialist call

## 2.4 Architectural primitives

The shapes that are expensive to rip out later.

### Entity model
- **Account** ≈ WorkOS Organization. Billable tenant.
- **Member** — user-in-account relationship. Users can belong to many accounts.
- **Role** — named scope bundle. Built-ins: `owner` / `admin` / `member`. Custom deferred.
- **Scope** — atomic permissions. `hasScope(member, scope, account)` is the only auth check. V1 implementation: hardcoded role→scope map (no scope table). Signature preserved so custom roles ship as data later. **`SENSITIVE_SCOPES` set** (`keys:revoke`, `members:remove`, `billing:*`) bypasses the 60s membership cache and reads from WorkOS or the strict Postgres mirror.
- **ApiKey** — Account-owned with `created_by` audit field. Member-owned only for the `noetic login` CLI flow with rotate-on-offboarding. Stored as `{prefix, pepper_version, hmac}` where `hmac = HMAC-SHA256(secret, pepper_v<N>)`. **Versioned pepper** (`pepper_v1`, `pepper_v2`, ... as separate Workers Secrets) allows lazy rotation. Env-prefixed: `noetic_live_*` / `noetic_test_*`.
- **BYOK UpstreamKey** — encrypted at rest with per-tenant DEK, write-only via dashboard (never displayed after creation), revocable independent of upstream provider. Two modes: (a) **proxied** — Noetic forwards via AI Gateway; (b) **async/SDK-side** — the SDK calls upstream directly and POSTs the trace to Noetic afterward, Noetic never sees the key. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- **Bucket** — metered allowance for a metric over a period: `{metric, period, included_quantity, overage_price, hard_cap}` (config in Postgres). V1 ships hardcoded buckets per account; config UI when ≥3 customers ask.
- **BucketState** — authoritative live counter in a **Durable Object per `(account_id, metric, period_start)`**. Holds `{used, reservations: {id → {worst_case, expires_at}}}`. Reservations have TTL; DO alarms sweep expired reservations. Reconciler diffs `used` against Tinybird every 5 minutes; `reserved = SUM(reservations.values.worst_case)` is computed live. Replaces the v1 Upstash design; see [§1.9 override 1](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- **UsageEvent** — append-only, immutable: `{account_id, member_id?, api_key_id?, metric, quantity, unit, ts, period_anchor, idempotency_key, dims jsonb}`. **Emitted via Cloudflare Queue, not fire-and-forget** — Queue consumer ships to Tinybird with retries + DLQ. `period_anchor` is a clamped period identifier for Stripe Meter rollover safety. PII-forbidden in `dims` enforced at producer **and** Tinybird-side (materialized view with regex/length checks; quarantine + alert on overflow).
- **AuditLog** — append-only event stream shipped to **Axiom** tagged by `account_id`. Written via **direct Cloudflare Queue enqueue** from the mutation handler (not Postgres outbox in v1). Consumer ships to Axiom with retries + DLQ. **Retention SLA = 7 years**: Axiom hot 90 days; nightly parquet → R2 archive job. Customer-facing audit read/export queries Axiom directly; deep-history queries hit R2.

### Two design decisions
1. **Usage as event-sourced metrics, not counters.** New metric = one producer change, zero schema changes. Reconciliation is free.
2. **Scopes in the hot path, roles only in UI.** Authorization is always `hasScope`. Adding "admin can do X but not Y" later is data.

### Authoritative bucket check (the non-negotiable)
- Pre-call: **reserve worst-case cost** (`max_tokens × model_price`) via an RPC to the DO for `(account, metric, period)`. Atomic check `used + sum(reservations.worst_case) + worst_case ≤ included + overage_allowance`; on success, store `{reservation_id, worst_case, expires_at = now() + upstream_timeout}` and return `reservation_id`. Single round-trip, strongly consistent, no separate-vendor outage.
- For hard-cap accounts: **refuse the request with 402/429 + `X-Remaining-Budget` header** — silent server-side clamp is forbidden (produces non-deterministic eval outputs).
- Post-call: settle actual usage by `reservation_id` — DO deletes the reservation and increments `used` by `actual`. Idempotent on the `reservation_id`.
- Expired reservations swept by DO alarm — leaks are bounded by the upstream timeout, not unbounded as the v1 scalar design allowed.
- Per-account in-flight concurrency cap enforced inside the same DO.
- **Durability/reconciliation:** DOs are strongly consistent and durably stored. Every 5 minutes, a reconciler diffs DO `used` against Tinybird `SUM(quantity) WHERE ts ≥ period_start AND period_anchor = current`. Discrepancy > 0.1% → alert + automatic DO correction. UsageEvent (Tinybird) is the source of truth for billing; DO is the fast access path.

### BYOK key-handling spec

The trust contract for the activation moment. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).

- **Storage:** encrypted at rest with per-tenant DEK. DEK wrapped by KMS (Workers Secrets v1; AWS KMS at SOC2 trigger). Key material never logged, never echoed, never displayed after creation.
- **UI contract:** write-only. Customer pastes key once; dashboard shows last-4 + creation timestamp + last-used. Edit = paste new key (revoke old).
- **Scope-restriction:** customer can scope the *forwarded* key to specific models or specific provider endpoints — Noetic only sends what's allowed.
- **Revocation:** revoking the BYOK record in Noetic invalidates it in seconds (no Hyperdrive cache; see §2.14). Upstream provider revocation is independent.
- **Mode A — proxied (default):** Worker → AI Gateway → upstream. Standard path; usage emitted from response.
- **Mode B — async/SDK-side:** `@noetic-tools/sdk` calls upstream directly with the customer's key. SDK POSTs trace + usage to Noetic asynchronously. **Noetic never sees the upstream key.** Removes the largest trust objection for security-conscious customers. ~few hundred LoC in the SDK; required for Mode A's existence to be a *choice*, not a requirement.

## 2.5 Stack

Organized by plane. Cloudflare-first; three external vendors fill gaps Cloudflare doesn't cover. See [§1.7](#17-cloudflare-first-cloud-strategy) for the cloud strategy and [§2.14](#214-cloud-architecture) for the layered architecture picture.

### Compute / edge (Cloudflare)

| Layer | Choice | Rationale |
|---|---|---|
| API + inference gateway | **Cloudflare Workers** running `packages/api` (Hono) | Edge-deployed, Hono runs natively, SSE works (30s CPU is CPU-bound, inference is idle-waiting), free DDoS + WAF baked in |
| Authoritative bucket counter | **Cloudflare Durable Objects** per `(account, metric, period)` with TTL'd reservations + alarms | Strongly consistent, co-located with Worker, no separate-vendor outage on the synchronous critical path. See [§1.9 override 1](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). |
| Eval/GEPA compute plane | **Cloudflare Containers** (when GA) or **Fly.io worker pool** | Does not fit Workers 30s CPU cap; provisioned separately. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions) product additions. |
| Local dev runtime | Bun | Fast, matches monorepo; same Hono code runs on Workers |
| Inference upstream wrapper | **Cloudflare AI Gateway** (free) **behind a `forwardToUpstream(provider, request)` abstraction** | Caching + provider fallback + real-time logs at no cost; abstraction preserves optionality if AI Gateway pricing changes or managed inference needs to own caching as a product feature |
| Background workers (billing reporter, reconciler, archive shipper) | **Cloudflare Cron Triggers + Queues** | Cron free with Workers Paid; Queues $0.40/1M ops |
| Audit / UsageEvent shipping | **Cloudflare Queues → Tinybird + Axiom** with retries + DLQ | Replaces Postgres outbox + Cron audit shipper (which had 60s+ lag under burst) and fire-and-forget UsageEvent POST (which dropped events). See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). |
| Dashboard hosting | **Cloudflare Pages** — extend `packages/web` (or split `packages/dashboard`) | Free at our scale; same-domain integration with Workers |
| Object storage (exports, generated reports, eventual audit dumps) | **Cloudflare R2** | Zero egress fees, S3-compatible |
| Postgres connection pooling | **Cloudflare Hyperdrive** | Workers can't hold long-lived Postgres connections; Hyperdrive pools + caches + TLS-terminates |
| DNS / CDN / WAF / Bot management | Cloudflare (already) | Free baseline |
| Secrets storage | **Cloudflare Workers Secrets / Secrets Store** | Sufficient for v1 (one HMAC pepper + handful of vendor tokens); KMS trigger condition documented in §1.7 |

### Data plane (external vendors — Cloudflare doesn't offer)

| Layer | Choice | Rationale |
|---|---|---|
| Relational core (OLTP) | **Neon** + Drizzle — **only** accounts, members, api_keys, buckets-config, billing_period_summary, outbox | Serverless Postgres for Workers; scales to zero; free tier covers v1. See [§1.5](#15-postgres-minimization-directive) for what does *not* go here. |
| Eventually-consistent caches | **Upstash Redis** — key-verification cache (60s), WorkOS membership cache (60s, excluding `SENSITIVE_SCOPES`), idempotency-key fingerprint, per-key RPS bucket | REST + pay-per-request fits Workers. **Not authoritative for bucket_state** (that moved to DOs in [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions)). |
| Usage analytics + time-series | **Tinybird** (or ClickHouse Cloud) | High write volume, append-only, analytical queries |
| Audit log | **Axiom** tagged by `account_id`, shipped from Postgres outbox via Cloudflare Logpush + worker | Append-only, immutable structurally, customer-facing read/export queries Axiom directly |

### Vendor services (managed product, not infrastructure)

| Layer | Choice | Rationale |
|---|---|---|
| Auth | **WorkOS AuthKit** | 1M MAU free; SSO/SCIM on enterprise trigger |
| Billing | **Stripe Billing Meters API** | Current API (legacy metered deprecated) |
| Email | **Resend** | Free 3K/mo, $20/mo for 50K |
| Webhooks (out) | **Svix** when first customer asks | Reliable delivery is a 2-week project we don't need now |
| Inference upstream | **OpenRouter** (default) + direct Anthropic/OAI | One API, normalized streaming; fronted by Cloudflare AI Gateway (abstracted for optionality) |
| External uptime probe | **UptimeRobot free tier** (50 monitors, 5-min interval) | Independent attestation source for `/v1/health` — a self-ping from a Cloudflare Worker is not credible SLA evidence to a customer's lawyer. Tier 0. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). |
| SOC2 evidence collection | **Vanta or Drata** from P0 unconditionally | Asymmetric cost: single-digit thousands to start, vs ~1 year of enterprise pipeline lost by deferring. See [§1.9 override 5](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). |

### Application-layer (in-house)

| Layer | Choice | Rationale |
|---|---|---|
| API keys | In-house: `{prefix, pepper_version, hmac}` with versioned Workers Secrets pepper + Upstash 60s verification cache | ~2 weeks total (engineering + dashboard UX); no vendor in auth hot path. Versioned pepper allows lazy rotation. See [§1.6](#16-unkey-rejected-in-house-keys--verification-cache) and [§1.9 override 6](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). |
| SDK | `@noetic-tools/sdk` thin wrapper | Surfaces trace IDs, ties to `@noetic-tools/core` |

## 2.6 Phased build

**Target: 12 weeks one engineer OR 8 weeks two engineers.** The original "6–8 weeks/1 engineer" headline was no longer honest after the round-2 additions (eval surface, BYOK key spec, AI Act analysis, Vanta kickoff, observability Tier 0). P6 (Svix, DPA, deletion state machine, status-page polish) moves out of paid-beta into "first paying customer + 30 days." See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).

### P0 — Foundation (wk 1–2)
- `packages/api` skeleton (Hono on Workers; Bun for local dev/tests)
- **CI gate:** every PR runs `wrangler deploy --dry-run`. Library selection rule: Workers-compatible variants only.
- Cloudflare account + Workers + Pages + R2 + Hyperdrive + **Durable Objects** + Queues provisioned
- **Hyperdrive query caching DISABLED for `api_keys`, `members`, and any authz-sensitive table.** Pooling stays on; caching is per-statement. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- Postgres schema on **Neon** (relational core only): `users`, `accounts`, `members`, `api_keys`, `buckets` (config), `billing_period_summary`. No `outbox` in v1 — audit/UsageEvent go via Queues directly. Hyperdrive in front.
- **`BucketStateDO`** scaffolded — reserve/settle/release/sweep methods, alarm-driven TTL on reservations
- Upstash Redis provisioned for **eventually-consistent caches only** (membership 60s, key-verification 60s, idempotency fingerprint, RPS buckets). Not authoritative.
- Axiom workspace provisioned. **Audit Queue → Axiom consumer** (replaces Postgres outbox + Cron audit shipper from v0). **Nightly parquet → R2 archive job** for 7-year retention SLA.
- Tinybird workspace + `UsageEvent` ingest endpoint. **UsageEvent Queue → Tinybird consumer** with retries + DLQ (replaces fire-and-forget POST).
- Tinybird-side **PII defense-in-depth**: materialized view with regex/length checks; reject or quarantine writes that exceed thresholds.
- WorkOS AuthKit integration. **WorkOS is source of truth on read path**: 60s membership cache in Upstash, webhooks for cache invalidation, daily reconciliation cron. **`SENSITIVE_SCOPES` bypass cache** and read strict.
- `hasScope()` middleware, default-deny. V1: hardcoded role→scope map.
- **Typed `AccountScope` repo** for compile-time tenant isolation (chosen over Postgres RLS — Hyperdrive's prepared-statement cache bypasses RLS).
- Account ID in every URL + CI cross-tenant pen-test suite
- **Sentry wired (free tier)** with `account_id` / `request_id` / `trace_id` context
- **Structured-logging discipline** — logger wrapper enforces tags; Logpush → Axiom for request logs
- **`/v1/health` Cron Worker** (1-minute) exercising auth + DO bucket reserve + Tinybird Queue ingest + AI Gateway round-trip
- **UptimeRobot external probe** against `/v1/health` (Tier 0 — independent attestation)
- **Vanta or Drata workspace** provisioned (SOC2 evidence collection from day 1; see [§1.9 override 5](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions))
- **Customer-support surface decision** (Plain or email-only) + on-call rotation document
- EU AI Act classification document (output of P-1 specialist call) lands here

### P0.5 — Time-to-first-value (wk 2, parallel)
- Signup auto-provisions personal Account on **Free tier** ([§2.17](#217-monetization-model--tiers)) + default `noetic_test_*` key + $20 BYOK trial bucket (cheap-cached models, identity-gated)
- **Success screen artifact: 5-line `@noetic-tools/sdk` snippet** running a typed agent → trace tree visible in dashboard within seconds + one eval score. (Not a `curl`.) Includes "Upgrade to Developer for $10/mo to unlock GEPA + sub-harness CLI" CTA.
- Instrument **time-to-first-200** and **time-to-first-eval-score** as north-star activation metrics
- "Switching from LangSmith" landing as primary migration page (`/migrate/langsmith`) — anchored on Developer-tier $29/mo savings
- "Migrating from OpenRouter/OpenAI" as secondary
- Resend onboarding email lifecycle (day 1 / 7 / 30)

### P1 — Account self-serve (wk 3)
- Members list, invite flow, role assignment UI
- **Customer-facing audit log** read + export API (Axiom-backed for 90 days; R2 archive for deeper history)
- Mutations enqueue audit events to Queue at commit (no Postgres outbox in v1)

### P2 — API keys + CLI auth (~1 week including UX, not 3–4 days)
- In-house: `noetic_<env>_<24B-base62>`. Stored as `{prefix, pepper_version, hmac}` with **versioned pepper** (`pepper_v1`, `pepper_v2`, ... as Workers Secrets)
- Verifier tries the key's tagged version; lazy re-HMAC on next use during rotation
- **Redis verification cache, 60s TTL** on `(prefix) → {account_id, scopes, status, entitlements, tier}`. Cache invalidated on revoke + scope change + tier change.
- Account-owned by default, `created_by` audit field, rotate-on-offboarding
- Per-key RPS token bucket (Upstash) — free-tier default, paid override
- **`Idempotency-Key` state machine**: `(account_id, key) → {state: in_flight | succeeded | failed, response_ref?}`. In-flight replays block-and-wait; streaming responses stored in R2.
- **CLI auth flow**: `noetic login` opens browser → WorkOS device-code flow → CLI receives + stores API key locally
- **CLI entitlement check**: protected commands (`noetic optimize`, sub-harness commands, etc.) verify the key's `entitlements` claim; entitlement-aware error messages with upgrade link
- **CLI offline grace**: last-known entitlements signed and cached locally for 7 days; check after 7 days requires network re-auth
- Dashboard UI: create / list / revoke / last-used / RPS-stats. Service-account model documented (debt for v1.1: rotation + scope-restriction UI).

### P3 — BYOK + observability gateway (wk 4–5)
- `@noetic-tools/sdk` wraps the gateway, surfaces trace IDs, integrates with `@noetic-tools/core`
- **`forwardToUpstream(provider, request)` abstraction** wrapping Cloudflare AI Gateway — preserves optionality if AI Gateway pricing changes (see [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions))
- **BYOK Mode A (proxied)**: customer key → AI Gateway → upstream. Standard path; usage emitted from response to Tinybird via Queue.
- **BYOK Mode B (async/SDK-side)**: SDK calls upstream directly with customer key; SDK POSTs trace + usage to Noetic asynchronously. **Noetic never sees the upstream key.** Removes the largest trust objection.
- **BYOK key storage spec implemented** (encrypted at rest with per-tenant DEK; write-only UI; revocation; scope-restriction). See §2.4.
- **Trial credits** ($20 cheap-cached, identity-gated): forward via Noetic's OR account through AI Gateway
- **Managed inference** path: feature flag for design partners only (CC + manual review + hard caps + signed ToS chargeback waiver)
- Pass-through model IDs with `noetic/` prefix at most — no model aliasing in v1
- Read usage from final SSE chunk (no tee in v1)

### P3.5 — Eval surface (wk 5–6, parallel with P3 tail)

**The moat. Without this, v1 has no answer to "why not LangSmith?" See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions) product additions.**

- In-product scorer definition (declarative or code), persisted per account
- Eval scores visible per trace in the dashboard
- One **GEPA optimization run** end-to-end visible in UI (input → variants → scored runs → winner)
- Eval/GEPA compute provisioned on **Cloudflare Containers (when GA) or Fly.io worker pool** — does not fit Workers 30s CPU cap
- Time-to-first-eval-score instrumented alongside TTF-200

### P4 — Metering + buckets (wk 6–7)
- **Authoritative bucket check via `BucketStateDO.reserve(account, metric, period, worst_case)`** — atomic, strongly consistent, TTL on reservations swept by DO alarms
- **Refuse hard-cap accounts with 402/429 + `X-Remaining-Budget` header.** No silent `max_tokens` clamp.
- Settle by `reservation_id` (idempotent)
- Per-account in-flight concurrency cap enforced inside the DO
- **One reconciler loop in v1** (Tinybird `UsageEvent` sum vs DO `used`) — tune in spec; expand later if needed
- Tinybird `UsageEvent` dedup on `(account_id, idempotency_key)` via materialized view, time-bounded
- `dims jsonb` PII validation at producer **and** Tinybird-side defense-in-depth
- Near-real-time current-hour usage view from Tinybird
- **Free-tier daily cap**: shard `period_start` into the key (`account:metric:YYYY-MM-DD`) to avoid hot-key behavior at 00:00 UTC. Alternative: Workers Analytics request count for the cap.
- Period rollover writes a `billing_period_summary` row in Postgres; historical detail stays in Tinybird

### P5 — Billing: all three commercial models (wk 7–10)
**All three pricing models ship together** ([§1.10](#110-monetization-commitment-api--cli-three-commercial-models)). +1 week vs the old P5 estimate.

- **Stripe Billing Meters API** (not legacy metered) for `agent-runs` and `eval-scores` meters
- **Four Stripe Products**:
  - `subscription_developer`: $10/mo flat + bundled allowances + overage on shared meters
  - `subscription_team`: $30/mo base + `subscription_item.quantity = seat_count` × $10/seat + shared allowances + overage
  - `payg`: pure metered, optional `cli_pro_addon` $9/mo per user
  - `enterprise`: custom subscription + custom meter prices + contract terms
- Per-event idempotency key `{account_id}:{metric}:{usage_event_id}`
- 60s micro-batch reporter
- **Stripe Meter period-boundary handling**: 5-minute grace window around rollover; stamp `period_anchor`; reconciler runs +10 min after every period rollover. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- **Manual replay tool built BEFORE first paid customer**, not as polish
- Self-computed `billing_period_summary`; nightly reconciliation diffs reported-to-Stripe vs UsageEvent sum
- Reporter lag SLO + alert
- Billing-correctness reconciler alerts to Sentry + Slack — **start with one loop**
- **`model_cost_usd` emitted as `UsageEvent` dimension** — per-account token economics tracked even on BYOK
- **Shadow-billing period** before going live (all three models exercised)
- **Tier-switching UX**: pre-confirmation preview ("based on current period's usage, on PAYG you'd pay $X; on Team you'd pay $Y"); instant entitlement transition on upgrade, end-of-period revert on downgrade
- **Entitlement propagation**: tier change → invalidate Upstash key-verification cache → CLI re-fetches entitlements on next call
- Stripe Customer Portal for self-serve subscription management
- Public `/pricing` page reflecting the locked tier shape ([§2.17](#217-monetization-model--tiers))
- Subscription lifecycle: `past_due` → degrade (read-only), not lockout
- **Prepaid credits** as a Tinybird-backed balance ledger — kept as an option for non-card payment paths; not the default (paid-beta cohort uses card subscriptions)

### P6 — First-paying-customer-plus-30-days (moved out of paid-beta gate)
- Status page (Instatus, 99.9% target) wired to UptimeRobot + `/v1/health` output
- PostHog wired for TTF-200 / TTF-first-eval-score funnels
- Svix for customer webhooks when first customer asks
- Upstash/Cloudflare rate limiting at the edge
- DPA + sub-processor list + prompt/response storage opt-out
- Deletion state machine: `soft_deleted → final_invoice_issued → pii_anonymized → hard_deleted-after-7y`
- ToS + AUP + upstream-outage refund policy

## 2.7 Day-1 must-gets

Cheap now, expensive later.

### Correctness
- Authoritative bucket check via **Durable Object** (`BucketStateDO.reserve/settle/release`) with TTL'd reservations swept by alarms
- Worst-case cost reservation pre-call; settle by `reservation_id`; **refuse with 402/429 for hard-cap accounts** (no silent `max_tokens` clamp)
- Per-account in-flight concurrency cap enforced inside the DO
- UsageEvent dedup on `(account_id, idempotency_key)` time-bounded (Tinybird materialized view)
- **`Idempotency-Key` state machine** on the gateway: `in_flight | succeeded | failed` with block-and-wait on in-flight; streaming responses in R2
- **UsageEvent and AuditLog emitted via Cloudflare Queues** (not fire-and-forget; not Postgres outbox + Cron) with retries + DLQ
- Stripe Billing Meters with deterministic idempotency keys + **5-min period-boundary grace window** + `period_anchor` field + +10-min post-rollover reconciler + manual replay tool **before first paid customer**

### Security
- API keys as `{prefix, pepper_version, hmac}` with **versioned Workers Secrets pepper** from day 1
- **Hyperdrive query caching disabled for `api_keys`, `members`, and any authz-sensitive table**
- **Typed `AccountScope` repo** for tenant isolation (chosen over Postgres RLS — RLS bypassed by Hyperdrive prepared-statement cache) + CI cross-tenant pen-test suite
- **`SENSITIVE_SCOPES`** (`keys:revoke`, `members:remove`, `billing:*`) bypass the 60s membership cache
- Audit log via Queue → Axiom (immutability is structural in the log store) + **nightly parquet → R2 archive for 7-year SLA**
- Schema validator on `UsageEvent.dims` at producer **and** Tinybird-side defense-in-depth (regex/length checks; quarantine + alert)
- WorkOS as source of truth on read path; webhooks for cache invalidation only

### BYOK key handling
- Encrypted at rest with per-tenant DEK (Workers Secrets v1; AWS KMS at SOC2 trigger)
- Write-only via dashboard (never displayed after creation)
- Customer-revocable independent of upstream
- Scope-restriction UI (model / endpoint)
- **Mode B (async/SDK-side)** ships in P3 alongside proxied Mode A — Noetic never sees the upstream key in Mode B

### Data shape
- Env-prefixed API keys (`noetic_live_*` / `noetic_test_*`)
- Account ID in every URL (`/v1/accounts/{id}/...`)
- All money as integer cents/microcents
- `UsageEvent.dims jsonb` for free-form dimensions + `period_anchor` field

### Product
- Signup auto-provisions personal Account + test key + **$20 trial bucket** (cheap-cached models, identity-gated)
- **Success screen = 5-line `@noetic-tools/sdk` snippet** running a typed agent → trace tree + eval score (not `curl`)
- TTF-200 **and TTF-first-eval-score** instrumented as activation metrics
- Customer-facing audit log read + export (Axiom 90d hot; R2 archive deep)
- Near-real-time current-hour usage view
- Public `/pricing` page **with 3 tier-shape variants tested in P-1** before paid beta
- Status page + stated 99.9% before paid beta
- **"Switching from LangSmith" landing as primary migration page**
- Resend onboarding email lifecycle (day 1 / 7 / 30)

### Observability (Tier 0 — see [§1.8](#18-observability-graduated-by-paying-customer-tier))
- Sentry wired (free tier)
- Structured-logging discipline enforced by a logger wrapper; Logpush → Axiom
- `/v1/health` Cron Worker exercising auth + DO bucket reserve + Tinybird Queue + AI Gateway every minute
- **UptimeRobot external probe** against `/v1/health` (independent attestation source)
- `model_cost_usd` emitted as `UsageEvent` dimension (tracks economics on BYOK)

### Compliance / trust
- **Vanta or Drata kicked off in P0 unconditionally** (SOC2 evidence collection)
- **EU AI Act specialist call before P0** ($500–800); classification document landed in P0
- Audit log retention SLA = 7 years (Axiom 90d + R2 archive)
- **Customer-support surface decision** + on-call rotation document

### Process
- **3-week P-1 hard gate with ≥3 written LOIs + dual-cohort discovery** before any P0 code
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
| Bucket check | **Durable Object** atomic reserve/settle with TTL'd reservations + 5min Tinybird reconciler | Same — purpose-built from day 1 |
| Billing | Stripe Billing Meters + 60s micro-batches + 5-min boundary grace | Real-time meter events, prepaid balances, multi-currency |
| Inference | BYOK (Mode A + Mode B) + trial pool + opt-in managed | Same; managed scales with fraud/compliance maturity |
| Audit log | Queue → Axiom + nightly parquet → R2 (7yr SLA) | S3 + Athena + hash-chained (only if compliance forces it) |
| Webhooks (out) | Polling endpoints + Svix when asked | Same; Svix scales |
| Rate limiting | Upstash Redis | Same |

## 2.10 Compliance & risk

ICP-independent baseline starts in P0; ICP-specific deltas layer on top.

### P0 baseline (every ICP)
- **SOC2 evidence collection: Vanta or Drata kicked off unconditionally.** Asymmetric cost — see [§1.9 override 5](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). Audit log + access reviews + change management baseline.
- **EU AI Act specialist call before P0** ($500–800). Noetic likely classifies as "provider of a general-purpose AI system" under Articles 53/55 — documentation/log-retention/transparency obligations independent of BYOK. Classification document lands in P0.
- **Audit log retention SLA: 7 years.** Axiom 90d hot + R2 nightly parquet archive (built in P0).
- Deletion state machine documented in P0.

### Ships by P5
- GDPR DPA + sub-processor list + prompt/response storage opt-out.

### Layered when triggered
- **Teams/enterprise ICP** (P-1 outcome): SOC2 Type II audit timeline accelerated; access-anomaly alerts; monitoring-coverage attestation via Vanta integration.
- **Data residency:** US-only with disclosure for v1; EU region added when first €€€ contract requires it.
- **Fraud / chargebacks (managed inference only):** CC + small auth charge before any managed call. Hard caps for first 30 days. Manual review over `$X/day`. Signed ToS chargeback waiver.

## 2.11 Open questions to resolve

These need answers before the relevant phase starts.

- ~~**Pricing units.**~~ Resolved 2026-06-15: **all three coexist** (subscription/seat tiers + PAYG + enterprise). Introductory pricing: Developer $10/mo, Team $30 + $10/seat, PAYG metered, Enterprise custom. See [§1.10](#110-monetization-commitment-api--cli-three-commercial-models) and [§2.17](#217-monetization-model--tiers).
- ~~**Free-tier shape.**~~ Resolved 2026-06-15: **1,000 agent-runs/mo + 500 eval scores/mo + 30-day trace retention.** See [§1.9 override 4](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- ~~**Unkey vs custom keys.**~~ Resolved 2026-06-14: in-house. See [§1.6](#16-unkey-rejected-in-house-keys--verification-cache).
- **Tinybird vs ClickHouse Cloud.** Tinybird is faster to ship; ClickHouse is more control. Lean Tinybird unless cost projection at 100K MAU rules it out.
- **Dashboard split.** Extend `packages/web` or split `packages/dashboard`? Defer until P1 starts.
- ~~**Trial credits funding.**~~ Resolved 2026-06-15: **$20/account lifetime, cheap-cached models, identity-gated.** See [§1.9 override 4](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- **Managed inference opt-in mechanic.** Determined by P-1 cohort outcome. If managed wins, it becomes a separate plan.

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
- **In-memory soft pre-filter on bucket checks** (DO atomic op is fast enough; pre-filter optimizes a hot path that has no users)
- **Postgres outbox + Cron audit shipper in v1** (replaced by direct Queue enqueue at commit time; outbox returns only if Stripe-side transactional audit is needed)
- **Postgres RLS** (typed `AccountScope` repo only)
- **Silent `max_tokens` clamp** (refuse with 402/429 explicitly)
- **Three reconciler loops from day 1** (start with one; tune in spec)
- **Honeycomb at Tier 2** (Workers Analytics + Sentry breadcrumbs suffice through ~50 customers)
- **"Migrating from OpenRouter/OpenAI" as the primary migration page** (replaced by "Switching from LangSmith")
- **§1.4 BYOK-vs-managed hedge framing** (commit to one ICP after P-1 dual-cohort)
- **Parallel P0 before P-1 passes**

## 2.13 Cost-coverage invariants

Architectural constraints, not implementation details. Together they bound the marginal cost of a free user to fractions of a cent per active month, regardless of how heavily they use the platform. Violating any of these requires an explicit decision-history entry.

1. **Redis verification cache (60s TTL) sits in front of every auth check** (except `SENSITIVE_SCOPES` which read strict). API-key lookups, scope resolution, and WorkOS membership all hit cache first. Cold-path Postgres / WorkOS calls scale with *unique active keys per minute*, not request rate. A user hammering at 1000 RPS produces ~1 cold lookup/minute, not 60K.
2. **Per-key Upstash token-bucket RPS limit.** Free tier: 5 RPS default. Paid tiers override upward. Hard ceiling — no overage path. Bounds worst-case auth-check load per key.
3. **Free-tier monthly caps**: 1,000 agent-runs/mo + 500 eval scores/mo + 30-day trace retention. Enforced at the gateway via DO or Workers Analytics. Replaces the inconsistent v1 "10K/day" cap. Daily-cap key shards `period_start` (`account:metric:YYYY-MM-DD`) to avoid hot-key behavior at 00:00 UTC.
4. **BYOK by default eliminates inference cost.** Customer pays OR/Anthropic/OAI directly. The biggest variable cost in the system is not on our P&L for the majority of users.
5. **Trial credits pool**: $20/account lifetime, **defaulted to cheap-cached models** (Haiku / 4o-mini); premium models require BYOK. Eligibility gated on verified business email **or** phone **or** GitHub ≥30d. Hits cap → "add your key." No overage. Funded out of Noetic's OR account.
6. **Hot-path state is split by consistency requirement.** Authoritative counters (`bucket_state`) live in Durable Objects; eventually-consistent caches (membership, key-verification, idempotency fingerprint, RPS) live in one Upstash instance. Fixed monthly cost (~$10–30/mo Upstash + DO time pennies) independent of user count.

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
- **Hyperdrive query caching policy:** disabled for `api_keys`, `members`, and any authz-sensitive table (cached SELECTs honor revoked keys for the TTL). Pooling stays on; caching is per-statement. Enforced at the repo layer. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions).
- **No `fs`, no `child_process`, no Node-only globals.** If a tool needs those, it runs as a Queue consumer in a separate Worker or as a Cloudflare Container.
- **CPU time discipline.** Per-request CPU budget on Workers Paid is 30s. Compute-heavy work runs in Cron-triggered Workers or Queue consumers. **Eval/GEPA explicitly does NOT fit Workers** — runs on Cloudflare Containers (when GA) or Fly.io worker pool.
- **AI Gateway abstraction:** all upstream calls go through `forwardToUpstream(provider, request)`. If AI Gateway monetizes or managed inference needs to own caching/fallback, swap to direct provider SDK + own cache (~1 week).

### Cloudflare exit playbook (2-page sketch for diligence)

Vendor concentration on Cloudflare (11 products) will be a Series A / acquirer diligence question. The plan is not to leave; the plan is to be *able* to leave.

| Component | Replacement | Estimated cost to move |
|---|---|---|
| Workers + Pages (API + dashboard) | Fly.io + Cloudflare Pages (or Vercel) for the API; Vercel/Netlify for the dashboard | ~1–2 weeks. Hono runs on both; the `forwardToUpstream` and `AccountScope` abstractions are already framework-agnostic. |
| Hyperdrive | Direct Neon serverless connection pooler (Neon provides its own) | ~1 day. Swap connection string. |
| Durable Objects (`BucketStateDO`) | Redis + Postgres (per-account row with `SELECT ... FOR UPDATE`) | ~1–2 weeks. The DO interface (reserve/settle/release) is already a clean abstraction. |
| AI Gateway | Direct provider SDK + own cache (KV/Redis) | ~1 week. Covered by the `forwardToUpstream` abstraction. |
| R2 | S3 / GCS / Backblaze B2 | ~few days. S3-compatible API; rsync or batch copy. |
| Queues | AWS SQS / GCP Pub/Sub / Upstash QStash | ~few days per consumer. |
| Cron Triggers | Any scheduler (k8s CronJob, Fly Machines schedule, GitHub Actions) | ~1 day. |
| Logpush | Vector or direct application-level shipping | ~1 day. |

**Total estimated exit cost: 3–5 engineer-weeks if it ever became necessary.** The abstraction points (`forwardToUpstream`, `AccountScope` repo, the DO interface, the Queue producer/consumer pairs) are already in place because they're good design independent of the exit question.

## 2.15 Observability & monitoring

Graduated by paying-customer tier. Decision rationale in [§1.8](#18-observability-graduated-by-paying-customer-tier); this section is the operational state.

### Tier 0 — Day 1 (always-on, $0)

Wired in P0 before any paid observability tool:

| Capability | Implementation |
|---|---|
| Error tracking | **Sentry free tier** with `account_id` / `request_id` / `trace_id` context |
| Request logs | **Cloudflare Logpush → Axiom** (same pipe as audit) |
| RED metrics per route | **Cloudflare Workers Analytics** (built-in) |
| Synthetic uptime (internal) | **`/v1/health` Cron Worker** every minute |
| Synthetic uptime (external) | **UptimeRobot free tier** (50 monitors, 5-min interval) — independent attestation source for SLA evidence in customer disputes. See [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). |
| Cost-economics tracking | `model_cost_usd` emitted as `UsageEvent` dimension from upstream usage block |

### Tier 1 — Paid-beta launch (~$20/mo)

Triggered by: first $1 of revenue.

| Capability | Implementation |
|---|---|
| Public status page | **Instatus** ($20/mo) wired to UptimeRobot + `/v1/health` |
| Billing-correctness alerts | **Start with ONE reconciler loop** (Tinybird vs DO `used`); add others if drift surfaces. Routes to Sentry + Slack. |
| Activation analytics | **PostHog free tier** — TTF-200 + TTF-first-eval-score + signup events |
| Incident channel | `#noetic-alerts` Slack |

### Tier 2 + Tier 3 — Moved to separate observability roadmap

Detail removed from this plan per [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions). Trigger conditions:
- **~10 paying customers / $1K+ MRR**: evaluate Better Stack ($24/mo bundling uptime + status + on-call) — possibly drop Instatus. Workers Analytics + Sentry breadcrumbs sufficient through ~50 customers; defer Honeycomb.
- **First enterprise SLA / SOC2 Type II**: evaluate Datadog/Grafana Cloud + PagerDuty + Vanta monitoring integration.

A separate observability roadmap doc tracks these when the trigger fires.

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

## 2.16 Competitive positioning

Round 2 PM flagged that the plan's stated moat ("framework + memory + eval/GEPA") is internal language — the customer-facing SaaS surface is "BYOK + traces + eval scoring + prompt versioning," which is **LangSmith's exact pitch**. Without an articulated competitive frame, the `/pricing` page in P5 has nothing to anchor against.

### Direct competitors

| Vendor | Pricing | What they ship | Where they're strong | Where they're weak |
|---|---|---|---|---|
| **LangSmith** | $39/mo Developer, $79/mo Plus, custom Enterprise | Traces + datasets + evals + prompt versioning | LangChain integration, market awareness | Eval workflow is a separate flow from tracing; tied to LangChain idioms |
| **Braintrust** | Free tier + paid usage-based | Eval-first platform, traces, prompt playground | Strong eval primitives; experiment-style UX | Less framework-aware; weak agent-loop support |
| **Helicone** | Free up to 100K req/mo, $25+/mo | Proxy + trace logging, async (no-proxy) mode | OSS available; fast onboarding; async mode = lower trust ask | Lighter on eval; not a typed agent framework |
| **Langfuse** | OSS self-host or $59+/mo cloud | Traces + evals + datasets | OSS escape hatch; self-host = data sovereignty | Operational burden if self-hosting; cloud UX trails LangSmith |

### Noetic wedge claims (test in P-1, refine in `/pricing`)

1. **GEPA optimization runs inline with traces.** LangSmith requires a separate eval workflow; Braintrust requires defining an experiment. Noetic ships GEPA as a button on a trace.
2. **Typed step contracts surface failure modes before runtime.** Generic tracing platforms can show you a failure happened; the `@noetic-tools/core` step type can prove it cannot. Defensible because it's framework-rooted, not telemetry-rooted.
3. **Memory layers as a first-class concept.** Competitors trace memory as a tool call; Noetic models it as a budgeted, projectable layer with its own observability.
4. **BYOK Mode B (async/SDK-side)** removes the "you'll see my Anthropic key" objection that proxy-mode platforms can't answer. Helicone is the only comp that ships this.

### Activation metrics where we commit to being undeniably better

- **TTF-200** (auth + key + first inference call) — target < 60s
- **TTF-first-eval-score** (signup → first scored run visible in dashboard) — target < 5 min, single tier 1 wedge metric

### Pricing-page comparison frame

The `/pricing` page must include a side-by-side comparison cell at typical volumes. Recommended:

| | LangSmith Developer | Braintrust paid | **Noetic Developer (introductory)** |
|---|---|---|---|
| Agent-runs/mo | 10K (traces) | varies | 10–20K bundled |
| Eval scores/mo | unlimited (tied to traces) | varies | 5K bundled |
| Trace retention | 14d | 30d | 90d |
| GEPA optimization | n/a | n/a | included |
| CLI Pro (sub-harness, multi-account, plugins) | n/a | n/a | included |
| **Price** | **$39/mo** | usage-based | **$10/mo** |

**The Developer-tier wedge is $29/mo less than LangSmith with strictly more features.** Team tier at 5 seats matches LangSmith Plus pricing ($80 vs $79). Above 5 seats Noetic costs slightly more (offset by SOC2 / audit export at Team tier vs only at LangSmith Enterprise). PAYG and Enterprise comparisons added once steady-state pricing is set. See [§1.10](#110-monetization-commitment-api--cli-three-commercial-models) and [§2.17](#217-monetization-model--tiers).

## 2.17 Monetization model & tiers

Operational state. Decision rationale in [§1.10](#110-monetization-commitment-api--cli-three-commercial-models). Introductory pricing applies for **the first 6 months of paid beta or first 100 paying customers (whichever comes later)**. Existing customers grandfather at intro pricing for 12 months from signup; after that, migrate to steady-state on next billing cycle with 60-day notice.

### Product surfaces

1. **General API access** (primary route): gateway + traces + memory + eval/GEPA. Monetized at launch.
2. **Paid CLI features** (secondary route): brings `@noetic-tools/cli` into the paid surface. OSS framework remains free.

### Tiers

| Tier | Model | Introductory | **Steady-state** | Seats | Bundled quotas | CLI Pro | BYOK |
|---|---|---|---|---|---|---|---|
| Free | n/a | $0 | $0 | 1 | 1K runs, 500 evals, 30d | ❌ | $20 trial pool, then required |
| Developer | Subscription | $10/mo | **$19/mo** | 1 | 10–20K runs, 5K evals, 90d | ✅ | required after trial |
| Team | Subscription (base + per-seat) | $30 + $10/seat | **$49 + $15/seat** | 2+ | Shared org quotas (scaled with seats) | ✅ per seat | required |
| Pay-as-you-go | Pure usage | TBD by P-1 | **$0.008/run + $0.03/eval** | 1 | None | ❌ default; $19/mo per-user add-on | required |
| Enterprise | Custom contract | Quote | Quote (typically $500+/mo) | Custom | Custom | ✅ all seats | required (or managed inference) |

### Unit economics (steady-state)

BYOK eliminates inference cost — the most expensive variable in the comp set. Our variable costs per active Developer customer/mo are tiny:

| Cost | Amount on $19 Developer |
|---|---|
| Stripe fees (2.9% + $0.30) | $0.85 |
| Tinybird ingest (≈40K UsageEvents) | <$0.10 |
| Upstash ops + DO time + R2 | <$0.10 |
| Workers compute | <$0.05 |
| Fixed-cost amortization | ~$0.20–1.00 depending on scale |
| **Total** | **~$2/mo** |
| **Gross margin** | **~89%** |

Even introductory $10/mo holds ~80% gross margin. Steady-state captures more of the value already being delivered, not a price needed for the bottom line.

### Metering anchors

- **`agent-runs`** — primary billable unit; pay-per-thing-the-agent-did
- **`eval-scores`** — secondary billable unit; tracks the moat
- **Tokens are NOT billable** — preserves [§1.4](#14-openrouter-pragmatism-debate) BYOK posture
- Trace storage beyond retention window — deferred meter

### CLI Pro feature cut (initial)

| Surface | OSS (free) | CLI Pro (paid) |
|---|---|---|
| `noetic run`, `noetic init`, basic step primitives, local eval | ✅ | ✅ |
| `noetic optimize` (GEPA) | ❌ | ✅ |
| `noetic eval --remote` (cloud datasets) | ❌ | ✅ |
| Sub-harness commands (`noetic claude-code`, `noetic codex`, `noetic opencode`, `noetic pi`) | ❌ | ✅ |
| Multi-account workspace switching | ❌ | ✅ |
| Plugin system installs | ❌ | ✅ |
| Project sync to cloud | ❌ | ✅ |

The cut will adjust based on customer signal — flagged as initial.

### Entitlement mechanism

- API key carries an `entitlements` claim alongside `scopes`, cached in Upstash with the 60s verification cache
- CLI checks entitlement on protected commands (`noetic optimize`, sub-harness commands, etc.)
- **Offline grace period: 7 days** — CLI keeps last-known entitlements signed locally so airplane mode works; failing the check after 7 days requires re-auth
- Entitlement-aware error messages: "`noetic optimize` requires Developer tier or above. Upgrade at https://noetic.tools/billing"

### Stripe schema (all three models share infrastructure)

| Stripe Product | Configuration |
|---|---|
| `subscription_developer` | Flat $10/mo subscription + bundled meter allowances + overage prices on the same Stripe Meters as PAYG |
| `subscription_team` | $30/mo base subscription + `subscription_item.quantity = seat_count` × $10/seat + shared org meter allowances + overage |
| `payg` | Pure metered, no flat fee. Optional `cli_pro_addon` subscription item ($9/mo per user). |
| `enterprise` | Manual quote; custom subscription + custom meter prices + contract terms |

Same `UsageEvent` stream feeds all of them via Stripe Meters. Same `BucketStateDO` enforces bundled allowances. The differences live in Stripe config, not in our metering code.

### Tier-switching UX requirements

- Customers can switch between any two tiers (Free ↔ Developer ↔ Team ↔ PAYG ↔ Enterprise)
- **Pre-confirmation preview**: "based on your current period's usage, on PAYG you'd pay $X; on Team you'd pay $Y"
- Stripe handles cancel + new subscription transitions; we handle the preview math and the entitlement transition (instant on subscription start; end-of-period on downgrade)
- No price-lock pause-and-resume in v1; cancellation = subscription ends end-of-period, entitlements revert to Free

### Open implementation questions

- Exact $X per agent-run + $Y per eval-score for PAYG — set by P-1
- "Bundled quotas (10–20K runs, 5K evals)" for Developer — final numbers set by free-tier-bleed math during shadow-billing
- Whether to allow Free → PAYG upgrade without credit card (probably no; tied to cost-coverage invariants)
- Whether enterprise managed-inference adds a multiplier on metered usage — likely yes, tied to upstream cost

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

Seven candidate specs, but **only S1 + S2 are drafted before P-1 closes** ([§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions): write only what P-1 has validated). S3–S7 sketched here so the dependency shape is visible; full drafts wait for P-1 outcome. Each spec describes the **ideal end state** of its area (per `.claude/rules/spec-guidelines.md` — no phased rollout language inside specs).

### Tier 1 — Foundation (drafted in P0)

**S1. Identity & Access Control**
Accounts, members, roles/scopes (hardcoded role→scope map behind `hasScope()`), `SENSITIVE_SCOPES` cache-bypass set, WorkOS AuthKit as source-of-truth-on-read with 60s Upstash cache + daily reconciliation, **typed `AccountScope` repo for multi-tenancy** (RLS rejected — Hyperdrive prepared-statement cache bypasses), CI cross-tenant pen-test, audit log via Cloudflare Queue → Axiom (no Postgres outbox in v1), 7-year retention SLA via R2 archive. Defines the auth contract every other spec depends on.

**S2. Metering Spine**
`UsageEvent` shape with `period_anchor` field; emission via Cloudflare Queue (not fire-and-forget); Tinybird ingest with materialized-view PII defense-in-depth; **`BucketStateDO` (Durable Object) per `(account, metric, period)`** with TTL'd reservations + alarm sweepers; worst-case-cost reservation semantics; **refuse with 402/429 for hard-cap accounts** (no silent clamp); `Idempotency-Key` state machine (`in_flight | succeeded | failed` with block-and-wait); one reconciler loop in v1; Stripe Meter period-boundary handling (5-min grace, `period_anchor`, +10-min reconciler). The metering contract every billable surface depends on.

### Tier 2 — Wedge (drafted after P-1 passes, before P3)

**S3. API Keys + CLI Auth** — sketch only until P-1
`noetic_<env>_<24B-base62>`, **versioned pepper** (`{prefix, pepper_version, hmac}`), HMAC-SHA256 with KMS-stored pepper, prefix-indexed lookup with **Hyperdrive caching disabled** for the table, constant-time HMAC compare, account-owned vs member-CLI-login model, rotate-on-offboarding, scope inheritance, **`entitlements` claim alongside scopes** for CLI Pro feature gating ([§1.10](#110-monetization-commitment-api--cli-three-commercial-models)), `Idempotency-Key` state machine consumer. CLI `noetic login` device-code flow; offline grace with signed local entitlement cache (7 days). Depends on S1 + S2.

**S4. Inference Gateway & SDK** — sketch only until P-1
BYOK Mode A (proxied via AI Gateway abstraction) and **Mode B (async/SDK-side)**; trial-credits-pool path; opt-in managed-inference feature flag; trace tie-in to `@noetic-tools/core` runs; `@noetic-tools/sdk` wrapper; response usage emission to UsageEvent Queue; SSE handling. Depends on S3 + S2.

### Tier 3 — Eval surface (the moat — drafted in parallel with S4)

**S4.5. Eval & GEPA Surface** — NEW per [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions)
In-product scorer definition; eval scores per trace in dashboard; GEPA optimization run end-to-end visible; compute plane on Cloudflare Containers (when GA) or Fly.io worker pool; TTF-first-eval-score instrumentation. Depends on S4 (gateway emits traces) + S2 (UsageEvent dimensions for eval scores).

### Tier 4 — Monetization (drafted only if P-1 returns usage-based pricing)

**S5. Billing — all three commercial models**
Per [§1.10](#110-monetization-commitment-api--cli-three-commercial-models), S5 ships subscription/seat tiers + PAYG + enterprise day 1; cannot collapse to seat-counting. Four Stripe Products (`subscription_developer`, `subscription_team`, `payg`, `enterprise`) sharing Stripe Billing Meters for `agent-runs` + `eval-scores`. Per-event idempotency, period-boundary safety, 60s micro-batch reporter, `billing_period_summary` in Postgres, one reconciliation loop initially, reporter-lag SLO + manual replay tool **before first paid customer**, prepaid credits ledger as Tinybird read model (option for non-card paths), Stripe Customer Portal, subscription-lifecycle handling (past_due → degrade). Tier-switching UX with pre-confirmation preview; entitlement-propagation invalidates Upstash key cache on tier change. Depends on S2 + S1.

### Tier 5 — Activation, Trust & Compliance (one combined spec, drafted last)

**S6. Activation, Pricing & Trust** — combined per [§1.9](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions) cuts
Signup auto-provision flow (account + key + $20 identity-gated trial bucket + `@noetic-tools/sdk` snippet success screen); TTF-200 + TTF-first-eval-score instrumentation; `/pricing` page locked per P-1 outcome; "Switching from LangSmith" migration page; status page wired to UptimeRobot + `/v1/health`; customer-facing audit log API; DPA + sub-processor list; prompt/response storage opt-out; deletion state machine; SOC2 evidence baseline (Vanta from P0); EU AI Act classification; upstream-outage refund policy; ToS/AUP; customer support surface. Depends on all prior specs.

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

Run **P-1** before any code. **No parallel P0 build** (per [§1.9 override 2](#19-round-2-panel-overrides-six-decisions--workers-footguns--product-additions)) — the 8 engineer-weeks of plumbing is the wrong forcing function for discovery, and the wedge is structurally weak in BYOK world without validated pull.

Specifically:

1. **Week 0 — pre-call artifacts** (built in parallel by anyone, not gated on engineer): pricing hypothesis with 3 variants → live static `/pricing` page; "Switching from LangSmith" landing page; competitive teardown ([§2.16](#216-competitive-positioning)); EU AI Act specialist call.
2. **Weeks 1–2 — dual-cohort discovery**: 8 developer/BYOK calls + 8 non-developer/managed calls.
3. **Week 3 — gate evaluation**: ≥3 written LOIs at a stated price + ≥8/15 trust validations. If pass → commit to ONE ICP, start P0. If fail → reposition or pause.
4. **In parallel (not gating)**: Vanta or Drata workspace provisioned; EU AI Act classification documented.

P0 starts only after the gate passes.

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
| 2026-06-15 | **Round 2 panel overrides (§1.9)**: six prior decisions overridden (bucket_state to Durable Objects with TTL'd reservations; P-1 to 3-week hard gate with kill criteria + dual cohort; §1.4 hedge → commit to one ICP after P-1; trial pool to $20 cheap-cached identity-gated; SOC2 evidence unconditional in P0; HMAC pepper versioned from day 1). Workers footgun corrections (Hyperdrive cache disabled for authz tables; UsageEvent via Queue not fire-and-forget; refuse not silent-clamp; Idempotency-Key state machine; SENSITIVE_SCOPES bypass; Tinybird PII defense-in-depth; audit via Queue not Postgres outbox; UptimeRobot external probe; typed AccountScope not RLS; free-tier daily-cap key sharding; Stripe Meter period-boundary handling). Product additions (P3.5 eval surface; eval compute on Containers/Fly.io; BYOK key spec including Mode B async/SDK-side; success-screen sdk snippet not curl; Switching-from-LangSmith primary migration; §2.16 competitive positioning). CEO additions (EU AI Act specialist call; customer support line item; AI Gateway abstraction; 7-year audit retention with R2 archive; Cloudflare exit playbook; schedule rebaseline to 12wk/1eng or 8wk/2eng). Free-tier shape and trial pool open questions resolved. §3 specs deferred: only S1+S2 in P0; S3-S7 wait for P-1 outcome. | Second adversarial panel review explicitly empowered to challenge §1 |
| 2026-06-15 | **Monetization commitment (§1.10, §2.17)**: two product surfaces (API primary, paid CLI secondary), three commercial models coexisting day 1 (subscription/seat tiers + PAYG + enterprise). **Introductory** (first 6 months / 100 customers): Developer $10/mo, Team $30 + $10/seat. **Steady-state**: Developer $19/mo, Team $49 + $15/seat, PAYG $0.008/agent-run + $0.03/eval-score. 12-month grandfather for early customers with 60-day notice. Unit-economics check: ~89% gross margin at steady-state, ~80% at introductory — BYOK eliminates inference cost so the most expensive comp-set variable is off-P&L. Metering anchors: `agent-runs` + `eval-scores` (tokens NOT billable). CLI Pro feature cut: GEPA, remote evals, sub-harness commands, multi-account, plugins all behind paid tier; OSS framework remains free. API keys gain `entitlements` claim cached in Upstash; CLI offline-grace 7 days with signed local cache. §2.11 Pricing-units open question resolved. P5 +1 week for all-three-models. S5 spec no longer collapses to seat-counting. | User commitments on monetization model + steady-state pricing in the black |
