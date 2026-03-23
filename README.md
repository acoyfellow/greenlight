# greenlight

Set the rules. Let agents work. Verify they didn't break anything.

Define what "correct" looks like in plain language. Greenlight watches your endpoints and gives you proof -- pass, fail, and why.

## What this is

Greenlight is a verification layer for unattended agentic work.

You write rules.
Agents, deploys, or automations do work.
Greenlight checks reality against your rules and gives you proof.

Core use case: you cannot babysit production while agents run. Greenlight tells you what passed, what failed, and when.

## What this is not

- Not an uptime monitor
- Not a QA suite builder
- Not a dashboard-first analytics tool

It is a rule/check/proof loop.

## Why people use it

1. Write rules, not test suites
   - Plain language like `GET /api/health returns 200`
2. Walk away from the keyboard
   - Start the loop and come back to green or red
3. Get receipts, not dashboards
   - Export proof JSON and attach it to PRs, client updates, or agent feedback loops

## Quick start

### 1) Run local dev

```bash
npm install
npx wrangler dev --port 8787 --local
```

Open:

`http://localhost:8787/`

### 2) Add rules in the UI

Examples:

- `GET /demo/health returns 200`
- `GET /demo/price -> .price is a number`
- `GET /demo/price -> .currency equals USD`

### 3) Run checks

- Click `Run now` for one pass
- Click `Start` for continuous checks

### 4) Verify results and export proof

You get:

- Per-rule pass/fail status
- Recent run history with durations
- Reliability summary
- Proof JSON export

## Proof JSON (example)

```json
{
  "project": "default",
  "pass_rate_24h": "100%",
  "checks": 7,
  "last_run": "2026-03-23T15:59:43Z",
  "failures": []
}
```

## Rule syntax (plain language)

```txt
METHOD /path returns STATUS
METHOD /path -> .field is a TYPE
METHOD /path -> .field equals VALUE
METHOD /path -> HEADER header exists
METHOD /path -> response time < NUMBERms
METHOD /path -> response is array with length > NUMBER
METHOD /path with {BODY} returns STATUS
METHOD /path twice within Ns -> second response .field is VALUE
```

`METHOD`: GET, POST, PUT, DELETE, PATCH

`TYPE`: number, string, boolean, object, array

## CLI (if you prefer terminal)

```bash
greenlight create <name>
greenlight gate <name> "<rule>"
greenlight gates <name>
greenlight start <name>
greenlight pause <name>
greenlight nudge <name> "..."
greenlight status <name>
greenlight logs <name>
greenlight destroy <name>
```

## HTTP API

- `POST /gates` add a rule
- `GET /gates` list rules
- `DELETE /gates/:name` remove rule
- `POST /nudge` add context/hint
- `GET /status` loop + summary
- `POST /start` start checks loop
- `POST /pause` pause checks loop
- `GET /proof` export proof bundle
- `WS /stream` live event feed

Response envelope:

```json
{ "ok": true, "command": "GET /status", "result": {}, "next_actions": [] }
```

## Deployment

Deploy:

```bash
npx wrangler deploy
```

Current custom domain route is configured in `wrangler.jsonc`.

## Limits and notes

- JavaScript/TypeScript runtime (Cloudflare Workers)
- Checks are HTTP-observable contracts
- Durable Object + SQLite state store
- AI binding is unavailable in local `--local` mode (expected)

## License

MIT
