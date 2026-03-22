# greenlight

**The model can be non-deterministic. The funnel must be deterministic.**

greenlight is a self-building loop on Cloudflare Workers. You define gates — executable assertions about what should be true. greenlight writes code until they pass, then ships it live. There is no spec. The gates are the spec.

One Durable Object. One SQLite database. Zero containers. Instant cold start.

```
npm install greenlight
```

## How it works

You write gates. Gates are executable assertions about what should exist in the world:

```bash
greenlight create my-app

greenlight gate my-app "GET /api/price returns 200"
greenlight gate my-app "GET /api/price → .price is a number"
greenlight gate my-app "GET /api/price → .currency equals USD"
greenlight gate my-app "GET /api/price twice within 1s → second response .cached is true"

greenlight start my-app
```

Four red gates. The loop starts. It writes code, pushes to git, runs gates in a V8 sandbox, iterates on failures, stops when everything is green. Then it publishes a live Worker at a URL.

You either clear the gates or you don't. No approximating your way to green.

## Examples

### A price API from nothing

```bash
greenlight create price-api

greenlight gate price-api "GET /api/price returns 200"
greenlight gate price-api "GET /api/price → .price is a number"
greenlight gate price-api "GET /api/price → .currency equals USD"
greenlight gate price-api "GET /api/price twice within 1s → second .cached is true"

greenlight nudge price-api "Use CoinGecko's free API"

greenlight start price-api
```

```
$ greenlight gates price-api
iteration 1:
  ✗ price-endpoint    GET /api/price returns 200           → 404
  ✗ has-price         .price is a number                   → (skipped)
  ✗ has-currency      .currency equals USD                 → (skipped)
  ✗ has-caching       second .cached is true               → (skipped)

iteration 3:
  ✓ price-endpoint    GET /api/price returns 200
  ✓ has-price         .price is a number
  ✗ has-currency      .currency equals USD                 → currency was "usd"
  ✗ has-caching       second .cached is true               → cached was undefined

iteration 5:
  ✓ price-endpoint
  ✓ has-price
  ✓ has-currency
  ✓ has-caching

published → https://price-api.greenlight.dev/app/
```

Five iterations. No spec. The gates defined the API contract. The agent figured out the rest.

### Fix a broken app

You have an existing project with busted endpoints. Clone it into greenlight and define what "working" looks like:

```bash
greenlight create dca-fix --repo https://github.com/you/dcainsights

greenlight gate dca-fix "GET /api/calculate?amount=100&frequency=monthly&start=2020-01-01&end=2025-01-01 returns 200"
greenlight gate dca-fix "GET /api/calculate?amount=100&frequency=monthly&start=2020-01-01&end=2025-01-01 → .totalInvested is a number"
greenlight gate dca-fix "GET /api/calculate?amount=100&frequency=monthly&start=2020-01-01&end=2025-01-01 → .returnPercent is a number"
greenlight gate dca-fix "GET /api/historical?symbol=SPY&range=5y returns 200"
greenlight gate dca-fix "GET /api/historical?symbol=SPY&range=5y → response is array with length > 1000"

greenlight nudge dca-fix "The CSV import fails on Cloudflare Workers. The file can't be imported at build time — fetch it at runtime and cache in SQLite."

greenlight start dca-fix
```

The gates describe what "not broken" means. The nudge tells the agent what you already know about the problem. The agent reads the existing code, fixes it, and iterates until every gate is green.

### Progressive hardening

Start simple. Add gates as you go. The app gets stricter over time:

```bash
# Day 1: just make it work
greenlight gate my-app "GET / returns 200"
greenlight gate my-app "GET /api/health returns 200"

# Day 2: add a real feature
greenlight gate my-app "POST /api/shorten with {url: 'https://example.com'} returns 201"
greenlight gate my-app "POST /api/shorten with {url: 'https://example.com'} → .shortId is a string"

# Day 3: harden it
greenlight gate my-app "POST /api/shorten with {url: 'not-a-url'} returns 400"
greenlight gate my-app "GET /api/shorten/nonexistent returns 404"
greenlight gate my-app "GET / → response time < 200ms"
greenlight gate my-app "GET / → Content-Security-Policy header exists"
```

Each new gate turns red. The loop restarts. The agent makes it green. The app accumulates correctness like a ratchet — it only moves forward.

### Custom gate: end-to-end flow

When one-liners aren't enough:

```bash
greenlight gate my-app --name "full-flow" --fn '
export default async (endpoint) => {
  // Create
  const created = await fetch(`${endpoint}/api/shorten`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" })
  });
  if (created.status !== 201) throw new Error(`Create: ${created.status}`);
  const { shortId } = await created.json();

  // Read
  const found = await fetch(`${endpoint}/api/shorten/${shortId}`);
  if (found.status !== 200) throw new Error(`Read: ${found.status}`);
  const body = await found.json();
  if (body.url !== "https://example.com") throw new Error(`URL mismatch: ${body.url}`);

  // Redirect
  const redirect = await fetch(`${endpoint}/${shortId}`, { redirect: "manual" });
  if (redirect.status !== 302) throw new Error(`Redirect: ${redirect.status}`);
  if (redirect.headers.get("location") !== "https://example.com") {
    throw new Error(`Location: ${redirect.headers.get("location")}`);
  }
}
'
```

Create, read, redirect — one gate tests the entire flow. If any step breaks, the gate names exactly which one.

## Gates are the spec

One's a prompt. The other's a guardrail.

A markdown spec is a document *about* intent. It requires interpretation. It drifts. It can say one thing while the code does another and both look plausible.

A gate is intent itself. It passes or it fails. There is nothing to interpret.

```
Traditional:    spec → derive tests → build → check tests → ship
greenlight:     gates → build → gates pass → ship
```

The gate `"GET /api/price returns 200"` says everything a spec would say about that endpoint — it must exist, it must be reachable, it must succeed — in a form that can be verified in milliseconds with zero ambiguity.

**If you can't express it as a gate, the agent doesn't need to know it.** If you have a preference about *how* — use CoinGecko, cache for 60 seconds — that's a nudge. Ephemeral. Optional. It decays the moment the agent no longer needs it.

## Gates

A gate is a one-liner or a function.

### One-liners

Plain assertions. greenlight compiles them to executable checks:

```bash
greenlight gate my-app "GET /api/price returns 200"
greenlight gate my-app "GET /api/price → .price is a number"
greenlight gate my-app "GET /api/price → response time < 500ms"
greenlight gate my-app "GET /api/calculate?amount=100 → .totalInvested equals 100"
greenlight gate my-app "POST /api/subscribe with {email: 'test@test.com'} returns 201"
greenlight gate my-app "GET /api/subscribe/test@test.com returns 200 after previous"
```

The `after previous` keyword chains gates. Order matters when you're testing state.

### Functions

For anything a one-liner can't express:

```bash
greenlight gate my-app --name "caching-works" --fn '
export default async (endpoint) => {
  const r1 = await fetch(`${endpoint}/api/price`);
  const r2 = await fetch(`${endpoint}/api/price`);
  const b1 = await r1.json();
  const b2 = await r2.json();
  if (!b2.cached) throw new Error("Second request should be cached");
}
'
```

Gates run in V8 isolates. They can fetch the published endpoint, parse responses, check timing, chain requests. They cannot access the filesystem or the network beyond the endpoint. A gate observes the published surface and nothing else.

### Lifecycle

```
RED ──→ agent iterates ──→ GREEN ──→ done
                │
                └── stuck after max iterations ──→ STUCK (pauses, waits for nudge)
```

Three states. Red: failing. Green: passing. Stuck: the agent tried `GREENLIGHT_MAX_ITERATIONS` times and can't get there. Stuck gates pause the loop and wait for a human.

## Nudges

Natural language is not the spec. It's a hint. It decays.

```bash
greenlight nudge my-app "Use CoinGecko's free API for price data"
greenlight nudge my-app "The CSV has a header row, skip it"
greenlight nudge my-app "Cache in SQLite, not in-memory"
```

A nudge informs the current iteration. The agent sees it, uses it or doesn't, moves on. Nudges are not persisted into the gate set. They help right now and evaporate when the model no longer needs them.

If you find yourself nudging the same thing repeatedly, it should be a gate:

```bash
# This nudge keeps recurring:
greenlight nudge my-app "Responses must include CORS headers"

# Make it a gate:
greenlight gate my-app "GET /api/price → Access-Control-Allow-Origin header exists"
```

If it can be asserted, it's a gate. If it's a preference about implementation, it's a nudge. Gates endure. Nudges decay.

## The loop

```
     ┌──────────────────────────────────────┐
     │          DO alarm fires               │
     ▼                                       │
  Query memories                             │
  "What did I try? What worked?"             │
     │                                       │
  Read code from git                         │
     │                                       │
  Call LLM with:                             │
  - red gates + their failure messages       │
  - relevant memories                        │
  - active nudges                            │
     │                                       │
  Write files → push to git                  │
     │                                       │
  Publish via Dynamic Worker Loader          │
     │                                       │
  Run all gates against published endpoint   │
     │                                       │
     ├── all green → record learnings → done │
     └── any red  → record failure ──────────┘
```

Each iteration starts fresh. The agent rehydrates by reading gates, memories, and code — not by carrying a novel. One tiny gem behind per iteration. Small iterations, strong notes.

Git storage is a [ripgit](https://github.com/deathbyknowledge/ripgit) Durable Object — a full Git remote over HTTP, no filesystem, no container. The agent reads files via `/file?ref=main&path=src/index.ts`, pushes via the smart HTTP protocol, diffs and searches via the API.

Code execution — both gates and the published app — runs on Cloudflare's Dynamic Worker Loader. V8 isolates, sandboxed, instant. Dependencies resolved via esm.sh at runtime. No `npm install`. No build step.

## Memory

greenlight remembers what worked and what didn't. No vector database. No embeddings. SQLite FTS5, local to the DO, instant.

Memories are created automatically:

- **Gate goes red → green**: what change fixed it
- **Iteration fails**: what didn't work and why
- **Nudge received**: what the human said (tagged ephemeral)

```sql
SELECT trigger, learning FROM memories WHERE memories MATCH 'CSV parsing';
-- "Skipping header row fixed the parse error on line 1"
-- "CoinGecko returns floats as strings, must parseFloat"
```

The agent queries memories before each iteration. It doesn't repeat mistakes. Goals survive. Conventions degrade. Reasoning never survives. So greenlight stores outcomes, not chains of thought.

## Configuration

```toml
# wrangler.toml
[vars]
GREENLIGHT_MODEL = "openrouter/moonshotai/kimi-k2.5"

[secrets]
GREENLIGHT_API_KEY = ""  # npx wrangler secret put GREENLIGHT_API_KEY
```

| Variable | Default | Description |
|---|---|---|
| `GREENLIGHT_MODEL` | `moonshotai/kimi-k2.5` | Any OpenRouter model |
| `GREENLIGHT_API_KEY` | — | OpenRouter API key (required) |
| `GREENLIGHT_MAX_ITERATIONS` | `20` | Attempts per gate before marking stuck |
| `GREENLIGHT_LOOP_INTERVAL` | `"30s"` | Delay between iterations |
| `GREENLIGHT_AUTO_PUBLISH` | `true` | Publish live Worker when all gates pass |

One model. Swap it when something better drops.

## UI

Open your greenlight instance in a browser. Inline HTML, no framework, no build step:

- **Gate list** — red / green / stuck indicators. Click for the last failure message.
- **Log stream** — WebSocket. What the agent is doing right now.
- **Nudge input** — one text field. Type, enter, agent gets it next iteration.
- **Add gate** — one text field. Type an assertion, enter, loop restarts.

The agent manages the code. You manage the gates. The UI reflects that division.

## CLI

```bash
greenlight create <name>              # Deploy a new instance
greenlight gate <name> "<assertion>"  # Add a gate
greenlight gate rm <name> "<name>"    # Remove a gate
greenlight gates <name>               # List gates with status
greenlight start <name>               # Start the loop
greenlight pause <name>               # Pause the loop
greenlight nudge <name> "..."         # Send a nudge
greenlight logs <name>                # Stream the log
greenlight status <name>              # Current state
greenlight destroy <name>             # Tear it down
```

All commands return JSON. Every response includes `next_actions`.

```json
{
  "ok": true,
  "command": "greenlight gates my-app",
  "result": {
    "gates": [
      { "name": "price-endpoint", "status": "green", "assertion": "GET /api/price returns 200" },
      { "name": "has-price", "status": "green", "assertion": "GET /api/price → .price is a number" },
      { "name": "has-caching", "status": "red", "assertion": "GET /api/price twice → second .cached is true", "lastError": "cached was false" }
    ],
    "loop": "running",
    "iteration": 7,
    "published": "https://my-app.greenlight.dev/app/"
  },
  "next_actions": [
    { "command": "greenlight nudge my-app \"...\"", "description": "Help with the failing gate" },
    { "command": "greenlight logs my-app", "description": "See what the agent is trying" }
  ]
}
```

## Architecture

```
┌──────────────────────────── Cloudflare ────────────────────────────┐
│                                                                    │
│  ┌──────────────────────┐     ┌───────────────────────┐           │
│  │  greenlight DO        │────→│  ripgit DO             │          │
│  │                       │     │                        │          │
│  │  SQLite:              │     │  Full git remote       │          │
│  │  - gates              │     │  over HTTP.            │          │
│  │  - memories (FTS5)    │     │  Push, fetch, diff,    │          │
│  │  - runs               │     │  search, file read.    │          │
│  │  - nudges (ephemeral) │     │  10GB per repo.        │          │
│  │  - state              │     └───────────────────────┘           │
│  │                       │                                         │
│  │  Loop engine:         │     ┌───────────────────────┐           │
│  │  - LLM calls          │────→│  Dynamic Worker Loader │          │
│  │  - gate runner        │     │                        │          │
│  │  - DO alarm schedule  │     │  V8 isolates:          │          │
│  │                       │     │  - gate execution      │          │
│  │  Endpoints:           │     │  - published app       │          │
│  │  GET  / (UI)          │     └───────────────────────┘           │
│  │  WS   /stream         │                                         │
│  │  POST /gates          │                                         │
│  │  POST /nudge          │                                         │
│  │  GET  /status         │                                         │
│  └──────────────────────┘                                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Three Cloudflare primitives. Nothing else.

## Limits

Honest about what this is and isn't:

- **JavaScript/TypeScript only.** V8 isolates run JS. Need Python, Rust, or a build toolchain? Wrong tool.
- **No shell.** The agent cannot `npm install` or run arbitrary commands. Dependencies come from esm.sh.
- **10GB per repo.** ripgit's DO SQLite cap. Fine for application code. Not for monorepos.
- **20 iterations default.** Prevents runaway spend. Nudge or raise the limit.
- **HTTP-observable gates only.** Gates test the published surface. They can't inspect source, check types, or run static analysis. If you need that, you need a different layer.

## Philosophy

Two things are durable: **gates** and **memories**. Everything else is liquid.

The code is generated, tested, shipped, regenerated. Never precious. The model is one env var — swap it tonight. The nudges decay as models improve. The loop itself is commodity infrastructure. The gates are the product.

The fix is always structural, never motivational.

## License

MIT
