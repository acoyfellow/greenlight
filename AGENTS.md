# AGENTS.md

## Cursor Cloud specific instructions

### Overview

greenlight is a Cloudflare Workers application (single Durable Object with embedded SQLite). The codebase is currently in **stub/skeleton state** -- all DO methods throw `"not implemented"` and most tests are expected to fail (48 fail, 5 pass). This is by design.

### Key commands

All npm scripts are in `package.json`:

- `npm run check` -- typecheck + lint (combines `tsc --noEmit` and `oxlint src/ test/`)
- `npm test` -- runs vitest with `@cloudflare/vitest-pool-workers` (uses Miniflare/workerd locally, no Cloudflare account needed)
- `npm run build` -- compiles TypeScript to `dist/`
- `npm run test:watch` -- vitest in watch mode

### Running the dev server

```
npx wrangler dev --port 8787 --local
```

- The `--local` flag avoids needing `CLOUDFLARE_API_TOKEN` for local development.
- AI bindings are not available locally (will show "not supported"). This is expected.
- The worker routes all requests to the `GreenlightDO` Durable Object.

### Testing notes

- Tests run inside Miniflare (workerd) via `@cloudflare/vitest-pool-workers`. No Docker or external services needed.
- `vitest.config.ts` uses `cloudflareTest()` plugin with `remoteBindings: false`.
- Test files are in `test/` directory with `*.test.ts` extension.
