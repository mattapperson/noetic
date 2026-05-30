# Cross-platform deployment smoke suite

Proves that **`@noetic-tools/core`** and **`@noetic-tools/code-agent`** build,
deploy, and actually **run** on every supported runtime by making a **live
OpenRouter call** on each one:

| Runtime | How it runs | Packages exercised |
|---|---|---|
| **Node 22** | built bundle, packages resolved from `node_modules` at runtime | core + code-agent |
| **Bun** | runs the TypeScript entry directly | core + code-agent |
| **Deno** | self-contained bundle (`node:` builtins via node-compat) | core + code-agent |
| **Browser** | bundle run in headless Chromium (Playwright) | core only — see note |
| **Cloudflare Workers** | real `workerd` locally + a real deploy + teardown | core only — see note |

`@noetic-tools/core` runs on **all five** runtimes. `@noetic-tools/code-agent`
runs on the three Node-module environments (Node, Bun, Deno); its published
`dist` cannot load in a browser or a Worker (see findings below).

The suite installs the two packages as **packed tarballs** (`npm pack` with the
release `publishConfig` applied), so every runtime consumes the *built,
publishable* `dist` — exactly what an external `npm install` would get — not the
workspace source.

## What each smoke does

- **core** — builds a `step.llm`, runs it through `AgentHarness` with
  `provider: 'openrouter'`, and asserts a non-empty reply + token usage. This is
  the live network call, and it runs on every runtime.
- **code-agent** — builds a code agent over the portable in-memory adapters,
  runs a live call through its harness, and verifies the portable Write→Read
  tool round-trip.

## Running locally

```bash
export OPENROUTER_API_KEY=sk-or-...

cd compat
bun run pack:packages     # build + pack core and code-agent into vendor/
npm install               # extract the tarballs as an external consumer
npx playwright install chromium   # for the browser target

export CLOUDFLARE_API_TOKEN=...   # needed for the Cloudflare deploy
export CLOUDFLARE_ACCOUNT_ID=...

bun run all               # build bundles + run every runtime (Cloudflare deploys for real)
# or a subset:
bun run.ts node bun deno

# run Cloudflare in local workerd instead of deploying:
bun --no-install run.ts --cf-local
```

Individual targets:

```bash
bun run smoke:node
bun run smoke:bun
bun run smoke:deno
bun run smoke:browser
bun run smoke:cloudflare              # real deploy + run + delete
bun run smoke:cloudflare -- --local   # local workerd
```

> Always invoke Bun targets with `--no-install` (the npm scripts already do).
> Bun re-links `node_modules/@noetic-tools/*` to the `.tgz` files when it
> auto-installs, which breaks Node/Deno/bundling that expect the extracted
> directories.

## Notes / findings

- **code-agent's published `dist` only loads in Node-module environments**
  (Node, Bun, Deno). Two distinct issues block the edge runtimes, and both are
  worth fixing upstream if browser/Worker support is desired:
  - **Browser:** the `dist` statically imports `node:url` (`fileURLToPath`) and
    `vscode-languageserver-protocol` through its LSP chunk, so it cannot be
    bundled for a browser even via the `./tools` subpath (lazy-loading the LSP
    tool would fix this).
  - **Cloudflare Workers:** a chunk runs `createRequire(import.meta.url)` at
    module load. `import.meta.url` is `undefined` in a bundled Worker, so the
    worker throws before handling any request — even with `nodejs_compat`.
  The browser and Worker targets therefore exercise core only and record
  code-agent as skipped with the specific reason.
- **Browser → OpenRouter goes through a proxy.** OpenRouter's CORS policy
  rejects the SDK's custom `x-openrouter-callmodel` header on preflight, so a
  browser cannot call OpenRouter directly — real browser apps proxy LLM calls
  through their own backend. The Playwright harness stands in for that proxy
  (forwards server-side, returns permissive CORS headers) so the in-page noetic
  code runs unmodified.

## CI

`.github/workflows/compat.yml` runs the whole matrix on every PR and push to
`main`, including a real Cloudflare deploy. Required repository secrets:

- `OPENROUTER_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
