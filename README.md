# greenlight

**The model can be non-deterministic. The funnel must be deterministic.**

greenlight is a self-building loop on Cloudflare Workers. You define gates — executable assertions about what should be true. greenlight writes code until they pass, then ships it live. There is no spec. The gates are the spec.

One Durable Object. One SQLite database. Zero containers. Instant cold start.

```
npm install greenlight
```

---

## Tutorial

This walks you through creating your first greenlight project. You'll add gates, start the loop, and watch it build a working API from nothing.

### Prerequisites

- A Cloudflare account
- Node.js 18+
- An [OpenRouter](https://openrouter.ai) API key

### Step 1: Create a project

```bash
greenlight create price-api
```

You should see:

```json
{ "ok": true, "command": "greenlight create price-api", "result": { "name": "price-api" } }
```

### Step 2: Add gates

Gates are what you want to be true. Nothing else.

```bash
greenlight gate price-api "GET /api/price returns 200"
greenlight gate price-api "GET /api/price → .price is a number"
greenlight gate price-api "GET /api/price → .currency equals USD"
```

Check them:

```bash
greenlight gates price-api
```

You should see three gates, all red.

### Step 3: Nudge the agent

A nudge is a hint — not a requirement. It helps the agent get there faster.

```bash
greenlight nudge price-api "Use CoinGecko's free API"
```

### Step 4: Start the loop

```bash
greenlight start price-api
```

The loop begins. Watch it:

```bash
greenlight logs price-api
```

You'll see the agent reading gates, writing code, pushing to git, running gates, iterating on failures. When all three gates turn green, the app is published.

### Step 5: Check the result

```bash
greenlight gates price-api
```

```
✓ get-api-price-returns-200
✓ has-price
✓ has-currency

published → https://price-api.greenlight.dev/app/
```

You now have a live API. The gates defined the contract. The agent figured out the rest.

---

## How-to Guides

### Fix a broken app

You have an existing project with busted endpoints. Clone it into greenlight and define what "working" looks like:

```bash
greenlight create dca-fix --repo https://github.com/you/dcainsights

greenlight gate dca-fix "GET /api/calculate?amount=100&frequency=monthly&start=2020-01-01&end=2025-01-01 returns 200"
greenlight gate dca-fix "GET /api/calculate?amount=100&frequency=monthly&start=2020-01-01&end=2025-01-01 → .totalInvested is a number"
greenlight gate dca-fix "GET /api/historical?symbol=SPY&range=5y returns 200"
greenlight gate dca-fix "GET /api/historical?symbol=SPY&range=5y → response is array with length > 1000"

greenlight nudge dca-fix "The CSV import fails on Cloudflare Workers. Fetch at runtime, cache in SQLite."

greenlight start dca-fix
```

The gates describe what "not broken" means. The nudge tells the agent what you already know. The loop iterates until every gate is green.

### Harden an app over time

Start simple. Add gates as you go:

```bash
# Day 1: make it work
greenlight gate my-app "GET / returns 200"
greenlight gate my-app "GET /api/health returns 200"

# Day 2: add a feature
greenlight gate my-app "POST /api/shorten with {url: 'https://example.com'} returns 201"
greenlight gate my-app "POST /api/shorten with {url: 'https://example.com'} → .shortId is a string"

# Day 3: harden
greenlight gate my-app "POST /api/shorten with {url: 'not-a-url'} returns 400"
greenlight gate my-app "GET /api/shorten/nonexistent returns 404"
greenlight gate my-app "GET / → response time < 200ms"
greenlight gate my-app "GET / → Content-Security-Policy header exists"
```

Each new gate turns red. The loop restarts. The agent makes it green. Correctness accumulates like a ratchet — it only moves forward.

### Write a custom gate

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
}
'
```

Create, read, redirect — one gate tests the entire flow. If any step breaks, the gate names exactly which one.

### Turn a recurring nudge into a gate

If you keep nudging the same thing, it should be structural:

```bash
# This nudge keeps recurring:
greenlight nudge my-app "Responses must include CORS headers"

# Make it a gate:
greenlight gate my-app "GET /api/price → Access-Control-Allow-Origin header exists"
```

If it can be asserted, it's a gate. If it's a preference about implementation, it's a nudge.

---

## Reference

### CLI

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

### HTTP API

| Method | Path | Description |
|---|---|---|
| `POST` | `/gates` | Add a gate. Body: `{ assertion, fn?, name? }` |
| `GET` | `/gates` | List all gates with status |
| `DELETE` | `/gates/:name` | Remove a gate |
| `POST` | `/nudge` | Add a nudge. Body: `{ text }` |
| `GET` | `/status` | Loop state + gate summary |
| `POST` | `/start` | Start the loop |
| `POST` | `/pause` | Pause the loop |
| `WS` | `/stream` | Live log stream |

All responses follow the envelope format: `{ ok, command, result?, error?, fix?, next_actions }`.

### Gate one-liner syntax

```
METHOD /path returns STATUS
METHOD /path → .field is a TYPE
METHOD /path → .field equals VALUE
METHOD /path → HEADER header exists
METHOD /path → response time < NUMBERms
METHOD /path → response is array with length > NUMBER
METHOD /path with {BODY} returns STATUS
METHOD /path twice within Ns → second response .field is VALUE
ASSERTION after previous
```

`METHOD`: GET, POST, PUT, DELETE, PATCH.
`TYPE`: number, string, boolean, array, object.
`after previous`: gate only runs if the prior gate passed.

### Gate states

| State | Meaning |
|---|---|
| `red` | Failing. Agent is iterating on it. |
| `green` | Passing. |
| `stuck` | Agent exhausted `GREENLIGHT_MAX_ITERATIONS`. Paused, waiting for nudge. |

### Configuration

```jsonc
// wrangler.jsonc
{
  "vars": {
    "GREENLIGHT_MODEL": "openrouter/moonshotai/kimi-k2.5",
    "GREENLIGHT_MAX_ITERATIONS": "20",
    "GREENLIGHT_LOOP_INTERVAL": "30",
    "GREENLIGHT_AUTO_PUBLISH": "true"
  }
}
```

Secrets (set via `npx wrangler secret put`):

| Secret | Description |
|---|---|
| `GREENLIGHT_API_KEY` | OpenRouter API key (required) |

| Variable | Default | Description |
|---|---|---|
| `GREENLIGHT_MODEL` | `moonshotai/kimi-k2.5` | Any OpenRouter model |
| `GREENLIGHT_MAX_ITERATIONS` | `20` | Attempts per gate before stuck |
| `GREENLIGHT_LOOP_INTERVAL` | `30` | Seconds between iterations |
| `GREENLIGHT_AUTO_PUBLISH` | `true` | Publish live Worker when all gates pass |

### Architecture

```
┌──────────────────────────── Cloudflare ────────────────────────────┐
│                                                                    │
│  ┌──────────────────────┐     ┌───────────────────────┐           │
│  │  greenlight DO        │────→│  ripgit DO            │           │
│  │                       │     │                       │           │
│  │  SQLite:              │     │  Full git remote      │           │
│  │  - gates              │     │  over HTTP.           │           │
│  │  - memories (FTS5)    │     │  Push, fetch, diff,   │           │
│  │  - runs               │     │  search, file read.   │           │
│  │  - nudges (ephemeral) │     │  10GB per repo.       │           │
│  │  - state              │     └───────────────────────┘           │
│  │                       │                                         │
│  │  Loop engine:         │     ┌───────────────────────┐           │
│  │  - LLM calls          │────→│  Dynamic Worker Loader │          │
│  │  - gate runner        │     │  (closed beta)         │          │
│  │  - DO alarm schedule  │     │                        │          │
│  │                       │     │  V8 isolates:          │          │
│  │  Endpoints:           │     │  - gate execution      │          │
│  │  GET  / (UI)          │     │  - published app       │          │
│  │  WS   /stream         │     └───────────────────────┘           │
│  │  POST /gates          │                                         │
│  │  POST /nudge          │                                         │
│  │  GET  /status         │                                         │
│  └──────────────────────┘                                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Limits

- **JavaScript/TypeScript only.** V8 isolates run JS. Need Python, Rust, or a build toolchain? Wrong tool.
- **No shell.** The agent cannot `npm install` or run arbitrary commands. Dependencies come from esm.sh.
- **10GB per repo.** ripgit's DO SQLite cap. Fine for application code.
- **20 iterations default.** Prevents runaway spend. Nudge or raise the limit.
- **HTTP-observable gates only.** Gates test the published surface. They can't inspect source, check types, or run static analysis.
- **Dynamic Worker Loader is in closed beta.** Works locally with Wrangler. Production access requires Cloudflare approval.

---

## Explanation

### Gates are the spec

A markdown spec is a document *about* intent. It requires interpretation. It drifts. It can say one thing while the code does another and both look plausible.

A gate is intent itself. It passes or it fails. There is nothing to interpret.

```
Traditional:    spec → derive tests → build → check tests → ship
greenlight:     gates → build → gates pass → ship
```

**If you can't express it as a gate, the agent doesn't need to know it.** If you have a preference about *how* — use CoinGecko, cache for 60 seconds — that's a nudge. Ephemeral, optional, decaying.

### Nudges vs gates

Natural language is not the spec. It's a hint.

A nudge informs the current iteration. It helps right now and evaporates when the model no longer needs it. Gates endure. Nudges decay.

The test: if it can be asserted, it's a gate. If it's a preference about implementation, it's a nudge.

### Memory

greenlight remembers what worked and what didn't. No vector database. No embeddings. SQLite FTS5, local to the DO, instant.

Memories are created automatically when gates change state or iterations fail. The agent queries them before each attempt. Goals survive compaction. Conventions degrade. Reasoning never survives. So greenlight stores outcomes, not chains of thought.

### The loop

```
     ┌──────────────────────────────────────┐
     │          DO alarm fires               │
     ▼                                       │
  Query memories                             │
     │                                       │
  Read code from git                         │
     │                                       │
  Call LLM with:                             │
  - red gates + failure messages             │
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

Each iteration starts fresh. The agent rehydrates by reading gates, memories, and code — not by carrying a novel. Small iterations, strong notes.

### Philosophy

Two things are durable: **gates** and **memories**. Everything else is liquid.

The code is generated, tested, shipped, regenerated. Never precious. The model is one env var — swap it tonight. The nudges decay as models improve. The loop itself is commodity infrastructure. The gates are the product.

The fix is always structural, never motivational.

## License

MIT
