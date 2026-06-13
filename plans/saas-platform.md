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
3. [Next concrete step](#next-concrete-step)
4. [Changelog](#changelog)

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
6. **Buy the boring stuff.** WorkOS (auth), Stripe Billing Meters (billing), Tinybird (usage analytics), Unkey (keys — TBD), Svix (webhooks when needed), Upstash (rate limiting). Custom code budget = UsageEvent ingestion + bucket check + the Noetic value layer.

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
- **Bucket** — metered allowance for a metric over a period: `{metric, period, included_quantity, overage_price, hard_cap}`. V1 ships hardcoded buckets per account; config UI when ≥3 customers ask.
- **UsageEvent** — append-only, immutable: `{account_id, member_id?, api_key_id?, metric, quantity, unit, ts, idempotency_key, dims jsonb}`. PII-forbidden in `dims` (schema-validated at producer).
- **AuditLog** — append-only Postgres table with `REVOKE UPDATE/DELETE` from app role. Written via outbox pattern for any mutation that calls Stripe/WorkOS.

### Two design decisions
1. **Usage as event-sourced metrics, not counters.** New metric = one producer change, zero schema changes. Reconciliation is free.
2. **Scopes in the hot path, roles only in UI.** Authorization is always `hasScope`. Adding "admin can do X but not Y" later is data.

### Authoritative bucket check (the non-negotiable)
- Pre-call: **reserve worst-case cost** (`max_tokens × model_price`) via atomic `UPDATE...RETURNING` on Postgres `bucket_state` row (or Redis `INCRBY`).
- For hard-cap accounts: **clamp `max_tokens` to remaining budget** — never trust the client.
- Post-call: settle actual usage, release unused reservation.
- Per-account in-flight concurrency cap (separate from rate limit).
- In-memory rollup is OK only as a soft pre-filter ahead of the authoritative check.

## 2.5 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend API | `packages/api` — Bun + Hono | Matches monorepo, fast HTTP, simple deploy |
| DB (OLTP) | Postgres (Neon or Supabase) + Drizzle | Boring, transactional, easy migrations |
| Usage analytics | Tinybird (or ClickHouse Cloud) | Day-1 decision — kills the future migration |
| Auth | WorkOS AuthKit | 1M MAU free, M2M, SSO/SCIM when enterprise asks |
| Billing | Stripe Billing Meters API | Current API (legacy metered is deprecated) |
| API keys | Evaluate Unkey first; HMAC+KMS-pepper custom only if rejected | Don't build what's free |
| Webhooks (out) | Svix (when first customer asks) | Reliable delivery is a 2-week project we don't need now |
| Rate limiting | Upstash Redis or Cloudflare | Not Postgres |
| Inference upstream | OpenRouter (default) + direct Anthropic/OAI | One API, normalized streaming |
| Dashboard | Extend `packages/web` (or split `packages/dashboard`) | Reuse existing shell |
| SDK | `@noetic-tools/sdk` thin wrapper | Surfaces trace IDs, ties to `@noetic-tools/core` |

## 2.6 Phased build

Target: paid beta in 6 weeks, one engineer. Realistic: 8 weeks.

### P0 — Foundation (wk 1)
- `packages/api` skeleton (Hono, Drizzle, migrations)
- Schema: `users`, `accounts`, `members`, `api_keys`, `buckets`, `bucket_state`, `billing_period_summary`, `outbox`, append-only `audit_log` with `REVOKE UPDATE/DELETE`
- WorkOS AuthKit integration. **WorkOS is source of truth on read path**: 60s TTL membership cache, webhooks for cache invalidation only, daily reconciliation cron
- `hasScope()` middleware, default-deny. V1: hardcoded role→scope map
- Account ID in every URL **plus** Postgres RLS or typed `AccountScope` repo guard
- CI cross-tenant pen-test suite (try-to-read-another-tenant)
- Tinybird ingest endpoint for `UsageEvent`

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
- Authoritative bucket check (Postgres `UPDATE...RETURNING` or Redis `INCRBY`) with worst-case-cost reservation
- Settle actual on response; release unused reservation
- `UNIQUE(account_id, idempotency_key)` partial-indexed by `ts` (or monthly partitions)
- `dims jsonb` producer-side schema validation (no prompts/tool args/secrets)
- Near-real-time current-hour usage view from Tinybird (10–30s lag)
- Spend alerts + graceful hard-cap UX (429 with `X-Remaining-Budget` header)
- Daily Postgres rollover → `bucket_periods` archive

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
- Authoritative bucket check via shared store (in-memory rollup is soft pre-filter only)
- Worst-case cost reservation pre-call; settle on response; clamp `max_tokens` for hard-cap accounts
- Per-account in-flight concurrency cap
- `UNIQUE(account_id, idempotency_key)` time-bounded
- Honor `Idempotency-Key` header on the gateway
- Outbox pattern for Stripe/WorkOS mutations
- Stripe Billing Meters (not legacy metered) with deterministic idempotency keys
- Reporter lag SLO + reconciliation job + manual replay tool

### Security
- HMAC-SHA256 + KMS-stored pepper for API key hash (not raw sha256)
- Postgres RLS or typed `AccountScope` repo + CI cross-tenant pen-test suite
- Append-only `audit_log` with `REVOKE UPDATE/DELETE`
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
| Bucket check | Postgres row-level UPDATE...RETURNING | Redis with Postgres reconciler |
| Billing | Stripe Billing Meters + 60s micro-batches | Real-time meter events, prepaid balances, multi-currency |
| Inference | BYOK + small trial pool + opt-in managed | Same; managed scales with fraud/compliance maturity |
| Audit log | Append-only Postgres + outbox | S3 + Athena + hash-chained |
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
