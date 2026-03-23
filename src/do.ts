import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config, Envelope, Gate, GateResult, LoopState, Memory, Nudge } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

class HttpError extends Error {
  status: number;
  code: string;
  fix?: string;

  constructor(status: number, code: string, message: string, fix?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.fix = fix;
  }
}

function envelope<T>(
  command: string,
  ok: boolean,
  result?: T,
  error?: { message: string; code: string },
  fix?: string,
  next_actions: Array<{ command: string; description: string }> = [],
): Envelope<T> {
  return { ok, command, result, error, fix, next_actions };
}

function json200(body: Envelope, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });
}

function html200(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html;charset=UTF-8" },
  });
}

function jsonRaw(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });
}

export interface Env {
  GREENLIGHT_DO: DurableObjectNamespace<GreenlightDO>;
  AI: Ai;
}

interface SloSummary {
  totalRuns: number;
  passRate: number;
  passRate24h: number;
  averageDurationMs: number;
  lastRunAt?: string;
}

interface Template {
  name: string;
  assertion: string;
  description: string;
}

type RouteEnv = {
  Bindings: Env;
  Variables: {
    command: string;
  };
};

export class GreenlightDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private streamSockets = new Set<WebSocket>();
  private app: Hono<RouteEnv>;
  private jwtJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    this.app = this.buildApp();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gates (
        name TEXT PRIMARY KEY,
        assertion TEXT,
        fn TEXT,
        status TEXT DEFAULT 'red',
        last_error TEXT,
        iterations INTEGER DEFAULT 0,
        "order" INTEGER,
        depends_on TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT,
        learning TEXT,
        source TEXT,
        created_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        trigger, learning, content=memories, content_rowid=id
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nudges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT,
        consumed INTEGER DEFAULT 0,
        created_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS loop_state (
        status TEXT DEFAULT 'idle',
        iteration INTEGER DEFAULT 0,
        last_run_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gate_name TEXT,
        pass INTEGER,
        error TEXT,
        duration_ms INTEGER,
        endpoint TEXT,
        run_at TEXT,
        loop_iteration INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER,
        window_start INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        type TEXT,
        message TEXT,
        data TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        token_hash TEXT UNIQUE,
        scope TEXT,
        created_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      )
    `);
    const count = [...this.sql.exec(`SELECT COUNT(*) as c FROM loop_state`)][0]!.c as number;
    if (count === 0) {
      this.sql.exec(`INSERT INTO loop_state (status, iteration) VALUES ('idle', 0)`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request, this.env);
  }

  private buildApp(): Hono<RouteEnv> {
    const app = new Hono<RouteEnv>();

    app.use("*", async (c, next) => {
      c.set("command", `${c.req.method} ${c.req.path}`);
      await next();
    });

    app.use("*", async (c, next) => {
      const allowsBootstrapWithoutAuth = c.req.method === "POST"
        && c.req.path === "/auth/bootstrap"
        && !this.hasApiKeyAuthEnabled();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && !allowsBootstrapWithoutAuth) {
        await this.requireMutationAccess(c.req.raw);
      }
      await next();
    });

    app.get("/demo/health", () => {
      const cfg = this.getConfig();
      if (cfg.demoFailureMode) {
        return jsonRaw({ ok: false, mode: "broken" }, 500);
      }
      return jsonRaw({ ok: true, mode: "healthy" }, 200);
    });

    app.get("/demo/price", () => jsonRaw({ price: 123.45, currency: "USD", cached: true }, 200));
    app.get("/demo/items", () => jsonRaw([{ id: 1 }, { id: 2 }, { id: 3 }], 200));
    app.get("/", () => html200(this.renderHomePage()));
    app.get("/demo", () => html200(this.renderDemoPage()));
    app.get("/openapi.json", () => jsonRaw(this.getOpenApiSpec(), 200));
    app.get("/docs", () => html200(this.renderAutoGeneratedDocs()));

    app.get("/stream", (c) => {
      const upgrade = c.req.header("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        throw new HttpError(426, "BAD_REQUEST", "Expected websocket upgrade", "Connect with a WebSocket client");
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      this.streamSockets.add(server);
      server.addEventListener("close", () => this.streamSockets.delete(server));
      server.addEventListener("error", () => this.streamSockets.delete(server));
      const logs = this.listLogs(25);
      for (const log of logs.reverse()) {
        server.send(JSON.stringify(log));
      }
      server.send(JSON.stringify({
        ts: new Date().toISOString(),
        type: "stream_connected",
        message: "Connected to greenlight stream",
      }));
      return new Response(null, { status: 101, webSocket: client });
    });

    app.get("/auth/status", (c) => {
      const command = c.get("command");
      return json200(envelope(command, true, this.getAuthSummary()));
    });

    app.get("/auth/tokens", (c) => {
      const command = c.get("command");
      return json200(envelope(command, true, { tokens: this.listAuthTokens() }));
    });

    app.post("/auth/bootstrap", async (c) => {
      const command = c.get("command");
      if (this.hasApiKeyAuthEnabled()) {
        throw new HttpError(409, "AUTH_ALREADY_ENABLED", "API key auth already configured", "Use POST /auth/rotate");
      }

      let json: Record<string, unknown> = {};
      try {
        json = await c.req.json() as Record<string, unknown>;
      } catch {
        json = {};
      }

      const provided = String(json.apiKey ?? "").trim();
      const apiKey = provided || this.generateApiToken();
      const token = await this.createAuthToken("primary", "admin", apiKey);
      this.setConfigValue("apiKeyHash", token.hash);
      this.broadcastLog("auth_bootstrapped", "Auth bootstrap complete", { tokenId: token.id });

      return json200(envelope(command, true, {
        authEnabled: true,
        apiKey,
        token: { id: token.id, name: token.name, scope: token.scope },
      }));
    });

    app.post("/auth/rotate", async (c) => {
      const command = c.get("command");
      if (!this.hasApiKeyAuthEnabled()) {
        throw new HttpError(400, "AUTH_DISABLED", "API key auth not configured", "Call POST /auth/bootstrap");
      }

      let json: Record<string, unknown> = {};
      try {
        json = await c.req.json() as Record<string, unknown>;
      } catch {
        json = {};
      }

      const provided = String(json.apiKey ?? "").trim();
      const apiKey = provided || this.generateApiToken();
      const previousPrimaryHash = this.getConfigValue("apiKeyHash");
      const token = await this.createAuthToken(`rotated-${Date.now()}`, "admin", apiKey);
      this.setConfigValue("apiKeyHash", token.hash);
      let revokedTokenId: number | undefined;
      if (previousPrimaryHash && previousPrimaryHash !== token.hash) {
        revokedTokenId = this.revokeAuthTokenByHash(previousPrimaryHash);
      }
      this.broadcastLog("auth_rotated", "Primary API key rotated", {
        tokenId: token.id,
        revokedTokenId,
      });
      return json200(envelope(command, true, {
        rotated: true,
        apiKey,
        token: { id: token.id, name: token.name, scope: token.scope },
        revokedTokenId,
      }));
    });

    app.post("/auth/tokens", async (c) => {
      const command = c.get("command");
      if (!this.hasApiKeyAuthEnabled()) {
        throw new HttpError(400, "AUTH_DISABLED", "API key auth not configured", "Call POST /auth/bootstrap");
      }
      const json = await c.req.json() as Record<string, unknown>;
      const name = String(json.name ?? "").trim() || `token-${Date.now()}`;
      const scopeRaw = String(json.scope ?? "write").trim().toLowerCase();
      const scope = this.validateAuthScope(scopeRaw);
      const token = await this.createAuthToken(name, scope);
      this.broadcastLog("auth_token_created", `Auth token created: ${name}`, { tokenId: token.id, scope });
      return json200(envelope(command, true, {
        token: { id: token.id, name: token.name, scope: token.scope },
        apiKey: token.apiKey,
      }));
    });

    app.delete("/auth/tokens/:id", (c) => {
      const command = c.get("command");
      const id = Number(c.req.param("id"));
      if (!Number.isFinite(id)) {
        throw new HttpError(400, "BAD_REQUEST", "Invalid token id");
      }
      const revoked = this.revokeAuthToken(id);
      if (!revoked) {
        throw new HttpError(404, "NOT_FOUND", "Token not found");
      }
      this.broadcastLog("auth_token_revoked", "Auth token revoked", { tokenId: id });
      return json200(envelope(command, true, { revoked: true, tokenId: id }));
    });

    app.get("/auth/jwt", (c) => {
      const command = c.get("command");
      return json200(envelope(command, true, { jwt: this.getJwtSettings() }));
    });

    app.post("/auth/jwt", async (c) => {
      const command = c.get("command");
      const json = await c.req.json() as Record<string, unknown>;
      const jwksUrl = String(json.jwksUrl ?? "").trim();
      if (!jwksUrl) {
        throw new HttpError(400, "MISSING_FIELD", "'jwksUrl' is required", "Provide JWKS URL");
      }
      const issuer = String(json.issuer ?? "").trim();
      const audience = String(json.audience ?? "").trim();
      const requiredScope = String(json.requiredScope ?? "greenlight:write").trim() || "greenlight:write";
      this.setConfigValue("authJwtJwksUrl", jwksUrl);
      this.setConfigValue("authJwtIssuer", issuer);
      this.setConfigValue("authJwtAudience", audience);
      this.setConfigValue("authJwtRequiredScope", requiredScope);
      this.jwtJwksCache.delete(jwksUrl);
      this.broadcastLog("auth_jwt_configured", "JWT auth configured");
      return json200(envelope(command, true, { jwt: this.getJwtSettings() }));
    });

    app.delete("/auth/jwt", (c) => {
      const command = c.get("command");
      this.deleteConfigValue("authJwtJwksUrl");
      this.deleteConfigValue("authJwtIssuer");
      this.deleteConfigValue("authJwtAudience");
      this.deleteConfigValue("authJwtRequiredScope");
      this.jwtJwksCache.clear();
      this.broadcastLog("auth_jwt_disabled", "JWT auth disabled");
      return json200(envelope(command, true, { jwt: this.getJwtSettings() }));
    });

    app.get("/auth/proof", async (c) => {
      const command = c.get("command");
      const proof = await this.buildAuthProof();
      return json200(envelope(command, true, proof));
    });

    app.get("/templates", (c) => {
      const command = c.get("command");
      return json200(envelope(command, true, { templates: this.getTemplates() }));
    });

    app.get("/config", (c) => {
      const command = c.get("command");
      const config = this.getConfig();
      const auth = this.getAuthSummary();
      return json200(envelope(command, true, {
        config,
        authEnabled: auth.authEnabled,
        authMethods: auth.methods,
      }));
    });

    app.post("/config", async (c) => {
      const command = c.get("command");
      const json = await c.req.json() as Record<string, unknown>;
      const key = String(json.key ?? "") as keyof Config;
      const value = json.value as Config[keyof Config];
      this.setConfig(key, value);
      this.broadcastLog("config_updated", `Config updated: ${key}`);
      return json200(envelope(command, true, { key, value }));
    });

    app.post("/demo/failure", async (c) => {
      const command = c.get("command");
      const json = await c.req.json() as Record<string, unknown>;
      const enabled = Boolean(json.enabled);
      this.setConfig("demoFailureMode", enabled);
      this.broadcastLog("demo_failure_mode", enabled ? "Demo mode set to broken" : "Demo mode set to healthy");
      return json200(envelope(command, true, { demoFailureMode: enabled }));
    });

    app.post("/demo/bootstrap", (c) => {
      const command = c.get("command");
      const templates = this.getTemplates();
      let created = 0;
      for (const template of templates) {
        const name = this.gateNameFromAssertion(template.assertion);
        if (this.getGateByName(name)) {
          continue;
        }
        this.addGate(template.assertion);
        created += 1;
      }
      const origin = new URL(c.req.url).origin;
      if (!this.getConfig().targetEndpoint) {
        this.setConfig("targetEndpoint", origin);
      }
      this.broadcastLog("demo_bootstrap", `Bootstrapped demo gates: ${created}`, { created });
      return json200(envelope(command, true, { created, templates: templates.length }));
    });

    app.get("/logs", (c) => {
      const command = c.get("command");
      const limit = Number(c.req.query("limit") ?? 100);
      return json200(envelope(command, true, { logs: this.listLogs(limit) }));
    });

    app.get("/runs", (c) => {
      const command = c.get("command");
      const limit = Number(c.req.query("limit") ?? 25);
      return json200(envelope(command, true, { runs: this.listRuns(limit) }));
    });

    app.get("/slo", (c) => {
      const command = c.get("command");
      return json200(envelope(command, true, { slo: this.getSloSummary() }));
    });

    app.get("/proof", async (c) => {
      const command = c.get("command");
      const proof = {
        generatedAt: new Date().toISOString(),
        loop: this.getLoopState(),
        gates: this.listGates(),
        published: this.getPublishedUrl(),
        recentRuns: this.listRuns(30),
        slo: this.getSloSummary(),
        config: this.getConfig(),
        auth: this.getAuthSummary(),
        authProof: await this.buildAuthProof(),
      };
      return json200(envelope(command, true, proof));
    });

    app.post("/run", async (c) => {
      const command = c.get("command");
      const origin = new URL(c.req.url).origin;
      const endpoint = this.resolveTargetEndpoint(origin);
      this.bumpIteration();
      let results = await this.runGates(endpoint);
      const selfBuild = await this.attemptSelfBuild(results, endpoint);
      if (selfBuild.applied) {
        results = await this.runGates(endpoint);
      }
      const gates = this.listGates();
      const published = gates.length > 0 && gates.every(g => g.status === "green")
        ? this.publishIfEligible(endpoint)
        : this.getPublishedUrl();
      this.broadcastLog("manual_run", "Manual run completed", { endpoint, gates: results.length });
      return json200(envelope(command, true, {
        endpoint,
        results,
        slo: this.getSloSummary(),
        selfBuild,
        published,
      }));
    });

    app.post("/gates", async (c) => {
      const command = c.get("command");
      const json = await c.req.json() as Record<string, unknown>;
      const assertion = json.assertion as string | undefined;
      const fn = json.fn as string | undefined;
      const name = json.name as string | undefined;
      if (!assertion && !fn) {
        throw new HttpError(400, "MISSING_FIELD", "Either 'assertion' or 'fn' is required", "Provide 'assertion' or 'fn'");
      }

      const gate = fn ? this.addGate(name ?? assertion ?? "custom", fn) : this.addGate(assertion!);
      this.broadcastLog("gate_added", `Gate added: ${gate.name}`, { name: gate.name, status: gate.status });
      return json200(envelope(command, true, gate, undefined, undefined, [
        { command: "GET /gates", description: "List all gates" },
        { command: "POST /start", description: "Start the loop" },
      ]));
    });

    app.get("/gates", (c) => {
      const command = c.get("command");
      return json200(envelope(command, true, {
        gates: this.listGates(),
        published: this.getPublishedUrl(),
      }, undefined, undefined, [
        { command: "POST /gates", description: "Add a gate" },
        { command: "POST /start", description: "Start the loop" },
      ]));
    });

    app.delete("/gates/:name", (c) => {
      const command = c.get("command");
      const name = decodeURIComponent(c.req.param("name"));
      const removed = this.removeGate(name);
      if (!removed) {
        throw new HttpError(404, "NOT_FOUND", "Gate not found");
      }
      this.broadcastLog("gate_removed", `Gate removed: ${name}`, { name });
      return json200(envelope(command, true, { removed: true }, undefined, undefined, [
        { command: "GET /gates", description: "List remaining gates" },
      ]));
    });

    app.post("/nudge", async (c) => {
      const command = c.get("command");
      const json = await c.req.json() as Record<string, unknown>;
      const text = String(json.text ?? "").trim();
      if (!text) {
        throw new HttpError(400, "MISSING_FIELD", "'text' is required", "Provide a non-empty text");
      }
      const nudge = this.addNudge(text);
      this.broadcastLog("nudge_added", "Nudge added", { text });
      return json200(envelope(command, true, nudge, undefined, undefined, [
        { command: "GET /status", description: "Check loop status" },
      ]));
    });

    app.get("/status", (c) => {
      const command = c.get("command");
      const loop = this.getLoopState();
      const gates = this.listGates();
      const summary = {
        total: gates.length,
        red: gates.filter(g => g.status === "red").length,
        green: gates.filter(g => g.status === "green").length,
        stuck: gates.filter(g => g.status === "stuck").length,
      };
      return json200(envelope(command, true, {
        loop,
        gates: summary,
        published: this.getPublishedUrl(),
      }, undefined, undefined, [
        { command: "POST /start", description: "Start the loop" },
        { command: "POST /gates", description: "Add a gate" },
      ]));
    });

    app.post("/start", (c) => {
      const command = c.get("command");
      const origin = new URL(c.req.url).origin;
      this.startLoop(origin);
      const state = this.getLoopState();
      this.broadcastLog("loop_started", "Loop started", { status: state.status });
      return json200(envelope(command, true, state, undefined, undefined, [
        { command: "GET /status", description: "Check status" },
        { command: "POST /pause", description: "Pause the loop" },
      ]));
    });

    app.post("/pause", (c) => {
      const command = c.get("command");
      this.pauseLoop();
      const state = this.getLoopState();
      this.broadcastLog("loop_paused", "Loop paused", { status: state.status });
      return json200(envelope(command, true, state, undefined, undefined, [
        { command: "POST /start", description: "Resume the loop" },
        { command: "GET /status", description: "Check status" },
      ]));
    });

    app.post("/destroy", (c) => {
      const command = c.get("command");
      this.destroyProject();
      return json200(envelope(command, true, { destroyed: true }, undefined, undefined, [
        { command: "GET /status", description: "Project state is reset" },
      ]));
    });

    app.notFound((c) => {
      const command = c.get("command");
      return json200(envelope(command, false, undefined, {
        message: "Not found",
        code: "NOT_FOUND",
      }), 404);
    });

    app.onError((err, c) => {
      const command = c.get("command") ?? `${c.req.method} ${c.req.path}`;
      if (err instanceof HttpError) {
        this.broadcastLog("error", `${command} failed: ${err.message}`, { code: err.code });
        return json200(
          envelope(command, false, undefined, { message: err.message, code: err.code }, err.fix),
          err.status
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      this.broadcastLog("error", `${command} failed: ${message}`);
      return json200(envelope(command, false, undefined, {
        message,
        code: "INTERNAL_ERROR",
      }), 500);
    });

    return app;
  }

  override async alarm(): Promise<void> {
    const loop = this.getLoopState();
    if (loop.status !== "running") {
      return;
    }

    try {
      this.bumpIteration();
      const endpoint = this.resolveTargetEndpoint();
      let results = await this.runGates(endpoint);
      const selfBuild = await this.attemptSelfBuild(results, endpoint);
      if (selfBuild.applied) {
        results = await this.runGates(endpoint);
      }
      const gates = this.listGates();
      const hasStuck = gates.some(g => g.status === "stuck");
      const allGreen = gates.length > 0 && gates.every(g => g.status === "green");

      if (allGreen) {
        const published = this.publishIfEligible(endpoint);
        this.sql.exec(`UPDATE loop_state SET status = 'done'`);
        this.ctx.storage.deleteAlarm();
        this.broadcastLog("loop_done", "All gates green", { gates: gates.length, published });
        return;
      }

      if (hasStuck) {
        this.sql.exec(`UPDATE loop_state SET status = 'paused'`);
        this.ctx.storage.deleteAlarm();
        this.broadcastLog("loop_stuck", "Loop paused due to stuck gate");
        return;
      }

      const cfg = this.getConfig();
      this.ctx.storage.setAlarm(Date.now() + cfg.loopInterval * 1000);
      this.broadcastLog("loop_tick", "Loop tick completed", {
        iteration: this.getLoopState().iteration,
        passing: results.filter(r => r.pass).length,
        total: results.length,
        selfBuildApplied: selfBuild.applied,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.broadcastLog("loop_error", `Alarm failed: ${message}`);
      this.sql.exec(`UPDATE loop_state SET status = 'paused'`);
      this.ctx.storage.deleteAlarm();
    }
  }

  addGate(assertion: string, fn?: string): Gate {
    const now = new Date().toISOString();
    const name = fn ? assertion : this.gateNameFromAssertion(assertion);
    const maxOrder = [...this.sql.exec(`SELECT MAX("order") as m FROM gates`)][0]!.m as number | null;
    const order = (maxOrder ?? -1) + 1;

    this.sql.exec(
      `INSERT INTO gates (name, assertion, fn, status, iterations, "order", created_at, updated_at)
       VALUES (?, ?, ?, 'red', 0, ?, ?, ?)`,
      name,
      assertion,
      fn ?? null,
      order,
      now,
      now
    );

    return {
      name,
      assertion,
      fn: fn ?? undefined,
      status: "red",
      iterations: 0,
      order,
      createdAt: now,
      updatedAt: now,
    };
  }

  removeGate(name: string): boolean {
    const before = [...this.sql.exec(`SELECT COUNT(*) as c FROM gates WHERE name = ?`, name)][0]!.c as number;
    if (before === 0) return false;
    this.sql.exec(`DELETE FROM gates WHERE name = ?`, name);
    return true;
  }

  listGates(): Gate[] {
    const rows = [...this.sql.exec(`SELECT * FROM gates ORDER BY "order"`)];
    return rows.map(r => ({
      name: r.name as string,
      assertion: r.assertion as string,
      fn: r.fn as string | undefined ?? undefined,
      status: r.status as Gate["status"],
      lastError: r.last_error as string | undefined ?? undefined,
      iterations: r.iterations as number,
      order: r.order as number,
      dependsOn: r.depends_on as string | undefined ?? undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  async runGates(endpoint: string): Promise<GateResult[]> {
    const gates = this.listGates();
    const config = this.getConfig();
    const iteration = this.getLoopState().iteration;
    const results: GateResult[] = [];

    for (const gate of gates) {
      const started = Date.now();
      let pass = true;
      let error: string | undefined;

      try {
        await this.executeGate(gate, endpoint);
      } catch (err) {
        pass = false;
        error = err instanceof Error ? err.message : String(err);
      }

      const durationMs = Date.now() - started;
      const attempts = pass ? 0 : gate.iterations + 1;
      const nextStatus: Gate["status"] = pass
        ? "green"
        : (attempts >= config.maxIterations ? "stuck" : "red");
      const now = new Date().toISOString();

      this.sql.exec(
        `UPDATE gates
         SET status = ?, last_error = ?, iterations = ?, updated_at = ?
         WHERE name = ?`,
        nextStatus,
        pass ? null : error ?? "unknown error",
        attempts,
        now,
        gate.name
      );

      this.sql.exec(
        `INSERT INTO runs (gate_name, pass, error, duration_ms, endpoint, run_at, loop_iteration)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        gate.name,
        pass ? 1 : 0,
        pass ? null : error ?? "unknown error",
        durationMs,
        endpoint,
        now,
        iteration
      );

      if (gate.status === "green" && !pass) {
        this.broadcastLog("gate_regression", `Gate regressed: ${gate.name}`, { error });
        this.ctx.waitUntil(this.sendAlert({
          kind: "gate_regression",
          gate: gate.name,
          error,
          endpoint,
        }));
      }
      if (gate.status !== "green" && pass) {
        this.broadcastLog("gate_recovered", `Gate recovered: ${gate.name}`);
      }
      if (!pass && nextStatus === "stuck") {
        this.broadcastLog("gate_stuck", `Gate stuck: ${gate.name}`, { error });
      }

      results.push({
        name: gate.name,
        pass,
        error,
        durationMs,
      });
    }

    return results;
  }

  recordMemory(trigger: string, learning: string, source: Memory["source"]): Memory {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO memories (trigger, learning, source, created_at) VALUES (?, ?, ?, ?)`,
      trigger,
      learning,
      source,
      now
    );
    const row = [...this.sql.exec(`SELECT last_insert_rowid() as id`)][0]!;
    const id = row.id as number;
    this.sql.exec(
      `INSERT INTO memories_fts (rowid, trigger, learning) VALUES (?, ?, ?)`,
      id,
      trigger,
      learning
    );
    return { id, trigger, learning, source, createdAt: now };
  }

  queryMemories(search: string, limit?: number): Memory[] {
    const lim = limit ?? 10;
    const rows = [...this.sql.exec(
      `SELECT m.id, m.trigger, m.learning, m.source, m.created_at
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ?
       LIMIT ?`,
      search,
      lim
    )];
    return rows.map(r => ({
      id: r.id as number,
      trigger: r.trigger as string,
      learning: r.learning as string,
      source: r.source as Memory["source"],
      createdAt: r.created_at as string,
    }));
  }

  addNudge(text: string): Nudge {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO nudges (text, consumed, created_at) VALUES (?, 0, ?)`,
      text,
      now
    );
    const row = [...this.sql.exec(`SELECT last_insert_rowid() as id`)][0]!;
    const id = row.id as number;
    return { id, text, consumed: false, createdAt: now };
  }

  consumeNudges(): Nudge[] {
    const rows = [...this.sql.exec(`SELECT * FROM nudges WHERE consumed = 0`)];
    if (rows.length > 0) {
      this.sql.exec(`UPDATE nudges SET consumed = 1 WHERE consumed = 0`);
    }
    return rows.map(r => ({
      id: r.id as number,
      text: r.text as string,
      consumed: false,
      createdAt: r.created_at as string,
    }));
  }

  getConfig(): Config {
    const read = (key: keyof Config): string | undefined => this.getConfigValue(key);
    return {
      model: read("model") ?? DEFAULT_CONFIG.model,
      maxIterations: Number(read("maxIterations") ?? DEFAULT_CONFIG.maxIterations),
      loopInterval: Number(read("loopInterval") ?? DEFAULT_CONFIG.loopInterval),
      autoPublish: (read("autoPublish") ?? String(DEFAULT_CONFIG.autoPublish)) === "true",
      targetEndpoint: read("targetEndpoint") ?? DEFAULT_CONFIG.targetEndpoint,
      rateLimitPerMinute: Number(read("rateLimitPerMinute") ?? DEFAULT_CONFIG.rateLimitPerMinute),
      alertWebhookUrl: read("alertWebhookUrl") ?? DEFAULT_CONFIG.alertWebhookUrl,
      demoFailureMode: (read("demoFailureMode") ?? String(DEFAULT_CONFIG.demoFailureMode)) === "true",
    };
  }

  setConfig(key: keyof Config, value: Config[keyof Config]): void {
    const validKeys: ReadonlyArray<string> = [
      "model",
      "maxIterations",
      "loopInterval",
      "autoPublish",
      "targetEndpoint",
      "rateLimitPerMinute",
      "alertWebhookUrl",
      "demoFailureMode",
    ];
    if (!validKeys.includes(key)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    this.setConfigValue(key, String(value));
  }

  getLoopState(): LoopState {
    const row = [...this.sql.exec(`SELECT * FROM loop_state`)][0]!;
    return {
      status: row.status as LoopState["status"],
      iteration: row.iteration as number,
      lastRunAt: row.last_run_at as string | undefined ?? undefined,
    };
  }

  startLoop(origin = "http://localhost"): void {
    const gates = this.listGates();
    if (gates.length === 0) {
      throw new Error("Cannot start loop without gates");
    }
    if (!this.getConfig().targetEndpoint) {
      this.setConfig("targetEndpoint", origin);
    }
    this.sql.exec(`UPDATE loop_state SET status = 'running'`);
    const cfg = this.getConfig();
    this.ctx.storage.setAlarm(Date.now() + cfg.loopInterval * 1000);
  }

  pauseLoop(): void {
    const state = this.getLoopState();
    if (state.status !== "running") {
      throw new Error("Cannot pause: loop is not running");
    }
    this.sql.exec(`UPDATE loop_state SET status = 'paused'`);
    this.ctx.storage.deleteAlarm();
  }

  private destroyProject(): void {
    this.ctx.storage.deleteAlarm();
    this.sql.exec(`DELETE FROM gates`);
    this.sql.exec(`DELETE FROM memories`);
    this.sql.exec(`DELETE FROM memories_fts`);
    this.sql.exec(`DELETE FROM nudges`);
    this.sql.exec(`DELETE FROM config`);
    this.sql.exec(`DELETE FROM runs`);
    this.sql.exec(`DELETE FROM rate_limits`);
    this.sql.exec(`DELETE FROM logs`);
    this.sql.exec(`DELETE FROM auth_tokens`);
    this.sql.exec(`DELETE FROM loop_state`);
    this.sql.exec(`INSERT INTO loop_state (status, iteration) VALUES ('idle', 0)`);
    this.jwtJwksCache.clear();
    for (const socket of this.streamSockets) {
      try {
        socket.close(1000, "project destroyed");
      } catch {
        // Ignore socket close errors during reset.
      }
    }
    this.streamSockets.clear();
  }

  private getTemplates(): Template[] {
    return [
      {
        name: "demo-health",
        assertion: "GET /demo/health returns 200",
        description: "Health endpoint should stay up",
      },
      {
        name: "demo-price-type",
        assertion: "GET /demo/price -> .price is a number",
        description: "Price must be numeric",
      },
      {
        name: "demo-currency",
        assertion: "GET /demo/price -> .currency equals USD",
        description: "Currency contract check",
      },
      {
        name: "demo-items",
        assertion: "GET /demo/items -> response is array with length > 2",
        description: "Array contract check",
      },
    ];
  }

  private resolveTargetEndpoint(origin?: string): string {
    const cfg = this.getConfig();
    if (cfg.targetEndpoint) {
      return cfg.targetEndpoint;
    }
    if (origin) {
      return origin;
    }
    throw new Error("No target endpoint configured");
  }

  private async attemptSelfBuild(
    results: GateResult[],
    endpoint: string
  ): Promise<{ applied: boolean; action?: string }> {
    const failing = results.filter(r => !r.pass);
    if (failing.length === 0) {
      return { applied: false };
    }
    const gates = this.listGates();
    const byName = new Map(gates.map(g => [g.name, g]));
    const cfg = this.getConfig();
    for (const failure of failing) {
      const gate = byName.get(failure.name);
      if (!gate) {
        continue;
      }
      const assertion = gate.assertion.toLowerCase();
      if (cfg.demoFailureMode && assertion.includes("/demo/health")) {
        this.setConfig("demoFailureMode", false);
        this.broadcastLog("fix_attempt", "Applied deterministic self-build fix", {
          action: "set demoFailureMode=false",
          gate: gate.name,
          endpoint,
        });
        return { applied: true, action: "set demoFailureMode=false" };
      }
    }
    this.broadcastLog("fix_attempt", "No deterministic self-build fix available", {
      failingGates: failing.map(f => f.name),
    });
    return { applied: false };
  }

  private publishIfEligible(endpoint: string): string | undefined {
    if (!this.getConfig().autoPublish) {
      return undefined;
    }
    const published = endpoint.replace(/\/+$/, "");
    this.setConfigValue("publishedUrl", published);
    this.broadcastLog("published", "Published URL updated", { url: published });
    return published;
  }

  private getPublishedUrl(): string | undefined {
    const value = this.getConfigValue("publishedUrl");
    return value?.trim() || undefined;
  }

  private async executeGate(gate: Gate, endpoint: string): Promise<void> {
    if (gate.fn) {
      await this.executeFunctionGate(gate.fn, endpoint);
      return;
    }
    await this.executeAssertionGate(gate.assertion, endpoint);
  }

  private async executeFunctionGate(fnSource: string, endpoint: string): Promise<void> {
    const normalized = fnSource
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const bodyMatch = normalized.match(/export\s+default\s+async\s*\([^)]*\)\s*=>\s*\{([\s\S]*)\}$/);
    if (!bodyMatch) {
      throw new Error("Unsupported function gate: expected `export default async (...) => { ... }`");
    }

    const body = bodyMatch[1]!.trim();
    const statements = body.split(";").map(s => s.trim()).filter(Boolean);
    const values = new Map<string, unknown>();
    const responses = new Map<string, Response>();

    for (const statement of statements) {
      if (statement === "return" || statement === "return undefined" || statement.startsWith("//")) {
        continue;
      }

      const fetchStmt = statement.match(/^const\s+([A-Za-z_]\w*)\s*=\s*await\s+fetch\(([\s\S]+)\)$/);
      if (fetchStmt) {
        const varName = fetchStmt[1]!;
        const args = this.splitTopLevel(fetchStmt[2]!, ",");
        const url = String(this.evaluateFnExpression(args[0]!, values, endpoint));
        let method = "GET";
        let redirect: "follow" | "manual" | "error" | undefined;
        let headers: Record<string, string> | undefined;
        let bodyValue: string | undefined;

        if (args[1]) {
          const options = args[1]!;
          const methodMatch = options.match(/method\s*:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/i);
          if (methodMatch) {
            method = methodMatch[1]!.toUpperCase();
          }
          const redirectMatch = options.match(/redirect\s*:\s*["'](follow|manual|error)["']/i);
          if (redirectMatch) {
            redirect = redirectMatch[1]!.toLowerCase() as "follow" | "manual" | "error";
          }
          const headerMatch = options.match(/headers\s*:\s*\{([\s\S]*?)\}/);
          if (headerMatch) {
            const raw = headerMatch[1]!;
            headers = {};
            const pairs = this.splitTopLevel(raw, ",");
            for (const pair of pairs) {
              const kv = pair.match(/["']?([^"':]+)["']?\s*:\s*["']([^"']+)["']/);
              if (kv) {
                headers[kv[1]!.trim()] = kv[2]!;
              }
            }
          }
          const bodyMatch = options.match(/body\s*:\s*JSON\.stringify\((\{[\s\S]*\})\)/);
          if (bodyMatch) {
            const obj = this.parseJsObjectLiteral(bodyMatch[1]!);
            bodyValue = JSON.stringify(obj);
          }
        }

        const init: RequestInit = {
          method,
          redirect,
          headers,
        };
        if (bodyValue !== undefined && method !== "GET" && method !== "HEAD") {
          init.body = bodyValue;
        }
        const response = await fetch(url, init);
        responses.set(varName, response);
        continue;
      }

      const statusCheck = statement.match(/^if\s*\(\s*([A-Za-z_]\w*)\.status\s*!==\s*(\d+)\s*\)\s*throw\s+new\s+Error\([\s\S]*\)$/);
      if (statusCheck) {
        const response = responses.get(statusCheck[1]!);
        if (!response) {
          throw new Error(`Unknown response variable: ${statusCheck[1]}`);
        }
        const expected = Number(statusCheck[2]!);
        if (response.status !== expected) {
          throw new Error(`Expected ${statusCheck[1]}.status ${expected}, got ${response.status}`);
        }
        continue;
      }

      const jsonDestructure = statement.match(/^const\s+\{\s*([A-Za-z_]\w*)\s*\}\s*=\s*await\s+([A-Za-z_]\w*)\.json\(\)\s*$/);
      if (jsonDestructure) {
        const field = jsonDestructure[1]!;
        const responseVar = jsonDestructure[2]!;
        const response = responses.get(responseVar);
        if (!response) {
          throw new Error(`Unknown response variable: ${responseVar}`);
        }
        const payload = await response.clone().json() as Record<string, unknown>;
        values.set(field, payload[field]);
        continue;
      }

      const jsonAssign = statement.match(/^const\s+([A-Za-z_]\w*)\s*=\s*await\s+([A-Za-z_]\w*)\.json\(\)\s*$/);
      if (jsonAssign) {
        const targetVar = jsonAssign[1]!;
        const responseVar = jsonAssign[2]!;
        const response = responses.get(responseVar);
        if (!response) {
          throw new Error(`Unknown response variable: ${responseVar}`);
        }
        values.set(targetVar, await response.clone().json());
        continue;
      }

      const neqFieldCheck = statement.match(
        /^if\s*\(\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*!==\s*([\s\S]+)\)\s*throw\s+new\s+Error\([\s\S]*\)$/
      );
      if (neqFieldCheck) {
        const objectVar = neqFieldCheck[1]!;
        const field = neqFieldCheck[2]!;
        const expectedExpr = neqFieldCheck[3]!;
        const objectValue = values.get(objectVar) as Record<string, unknown> | undefined;
        if (!objectValue || typeof objectValue !== "object") {
          throw new Error(`Unknown object variable: ${objectVar}`);
        }
        const expected = this.evaluateFnExpression(expectedExpr, values, endpoint);
        if (objectValue[field] !== expected) {
          throw new Error(`Expected ${objectVar}.${field} to equal ${String(expected)}, got ${String(objectValue[field])}`);
        }
        continue;
      }

      const neqVarCheck = statement.match(/^if\s*\(\s*([A-Za-z_]\w*)\s*!==\s*([\s\S]+)\)\s*throw\s+new\s+Error\([\s\S]*\)$/);
      if (neqVarCheck) {
        const varName = neqVarCheck[1]!;
        const expected = this.evaluateFnExpression(neqVarCheck[2]!, values, endpoint);
        if (values.get(varName) !== expected) {
          throw new Error(`Expected ${varName} to equal ${String(expected)}, got ${String(values.get(varName))}`);
        }
        continue;
      }

      throw new Error(`Unsupported function gate syntax: ${statement}`);
    }
  }

  private splitTopLevel(text: string, separator: string): string[] {
    const out: string[] = [];
    let current = "";
    let depthParen = 0;
    let depthBrace = 0;
    let depthBracket = 0;
    let quote: "'" | "\"" | "`" | null = null;
    let escaped = false;

    for (const ch of text) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        current += ch;
        escaped = true;
        continue;
      }
      if (quote) {
        current += ch;
        if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === "'" || ch === "\"" || ch === "`") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "(") depthParen += 1;
      if (ch === ")") depthParen -= 1;
      if (ch === "{") depthBrace += 1;
      if (ch === "}") depthBrace -= 1;
      if (ch === "[") depthBracket += 1;
      if (ch === "]") depthBracket -= 1;
      if (ch === separator && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
        out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) {
      out.push(current.trim());
    }
    return out;
  }

  private evaluateFnExpression(expr: string, values: Map<string, unknown>, endpoint: string): unknown {
    const text = expr.trim();
    if (!text) return "";
    if (text === "endpoint") return endpoint;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "null") return null;
    if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1);
    }
    if (text.startsWith("`") && text.endsWith("`")) {
      const inner = text.slice(1, -1).replace(/\\\$\{/g, "${");
      return inner.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
        const key = name.trim();
        if (key === "endpoint") {
          return endpoint;
        }
        if (!values.has(key)) {
          throw new Error(`Unknown interpolation variable: ${key}`);
        }
        return String(values.get(key));
      });
    }
    if (text.includes("+")) {
      const parts = this.splitTopLevel(text, "+");
      return parts.map(part => String(this.evaluateFnExpression(part, values, endpoint))).join("");
    }
    if (values.has(text)) {
      return values.get(text);
    }
    throw new Error(`Unsupported expression: ${expr}`);
  }

  private parseJsObjectLiteral(rawObject: string): Record<string, unknown> {
    const normalized = rawObject
      .trim()
      .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, "$1\"$2\":")
      .replace(/'/g, "\"");
    try {
      return JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid object literal: ${rawObject}`);
    }
  }

  private async executeAssertionGate(assertion: string, endpoint: string): Promise<void> {
    const text = assertion.trim();

    const twice = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+twice\s+within\s+(\d+)s\s*(?:→|->)\s*second\s+(?:response\s+)?\.(\w+)\s+is\s+(.+)$/i
    );
    if (twice) {
      const method = twice[1]!;
      const path = twice[2]!;
      const field = twice[4]!;
      const raw = twice[5]!;
      await fetch(endpoint + path, { method });
      const second = await fetch(endpoint + path, { method });
      const secondBody = await second.json() as Record<string, unknown>;
      const expected = this.parseLiteral(raw);
      if (secondBody[field] !== expected) {
        throw new Error(`Expected second .${field} to be ${String(expected)}, got ${String(secondBody[field])}`);
      }
      return;
    }

    const withBody = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+with\s+(\{.*\})\s+returns\s+(\d+)$/i
    );
    if (withBody) {
      const method = withBody[1]!;
      const path = withBody[2]!;
      const bodyRaw = withBody[3]!;
      const statusRaw = withBody[4]!;
      let body: unknown;
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        throw new Error("Body assertions require valid JSON object syntax");
      }
      const res = await fetch(endpoint + path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const expectedStatus = Number(statusRaw);
      if (res.status !== expectedStatus) {
        throw new Error(`Expected status ${expectedStatus}, got ${res.status}`);
      }
      return;
    }

    const returns = text.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+returns\s+(\d+)$/i);
    if (returns) {
      const method = returns[1]!;
      const path = returns[2]!;
      const statusRaw = returns[3]!;
      const res = await fetch(endpoint + path, { method });
      const expectedStatus = Number(statusRaw);
      if (res.status !== expectedStatus) {
        throw new Error(`Expected status ${expectedStatus}, got ${res.status}`);
      }
      return;
    }

    const typeMatch = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*\.(\w+)\s+is\s+a\s+(number|string|boolean|object|array)$/i
    );
    if (typeMatch) {
      const method = typeMatch[1]!;
      const path = typeMatch[2]!;
      const field = typeMatch[3]!;
      const type = typeMatch[4]!;
      const res = await fetch(endpoint + path, { method });
      const body = await res.json() as Record<string, unknown>;
      const actual = body[field];
      if (type === "array") {
        if (!Array.isArray(actual)) {
          throw new Error(`Expected .${field} to be array`);
        }
        return;
      }
      if (type === "object") {
        if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
          throw new Error(`Expected .${field} to be object`);
        }
        return;
      }
      if (typeof actual !== type) {
        throw new Error(`Expected .${field} to be ${type}, got ${typeof actual}`);
      }
      return;
    }

    const equals = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*\.(\w+)\s+equals\s+(.+)$/i
    );
    if (equals) {
      const method = equals[1]!;
      const path = equals[2]!;
      const field = equals[3]!;
      const raw = equals[4]!;
      const res = await fetch(endpoint + path, { method });
      const body = await res.json() as Record<string, unknown>;
      const expected = this.parseLiteral(raw);
      if (body[field] !== expected) {
        throw new Error(`Expected .${field} to equal ${String(expected)}, got ${String(body[field])}`);
      }
      return;
    }

    const header = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*(\S+)\s+header\s+exists$/i
    );
    if (header) {
      const method = header[1]!;
      const path = header[2]!;
      const key = header[3]!;
      const res = await fetch(endpoint + path, { method });
      if (!res.headers.has(key)) {
        throw new Error(`Expected header ${key} to exist`);
      }
      return;
    }

    const time = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*response\s+time\s*<\s*(\d+)ms$/i
    );
    if (time) {
      const method = time[1]!;
      const path = time[2]!;
      const msRaw = time[3]!;
      const start = Date.now();
      await fetch(endpoint + path, { method });
      const elapsed = Date.now() - start;
      const maxMs = Number(msRaw);
      if (elapsed >= maxMs) {
        throw new Error(`Response time ${elapsed}ms exceeded ${maxMs}ms`);
      }
      return;
    }

    const array = text.match(
      /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s*(?:→|->)\s*response\s+is\s+array\s+with\s+length\s*>\s*(\d+)$/i
    );
    if (array) {
      const method = array[1]!;
      const path = array[2]!;
      const minRaw = array[3]!;
      const res = await fetch(endpoint + path, { method });
      const body = await res.json() as unknown;
      if (!Array.isArray(body)) {
        throw new Error("Expected response to be an array");
      }
      const min = Number(minRaw);
      if (body.length <= min) {
        throw new Error(`Expected response length > ${min}, got ${body.length}`);
      }
      return;
    }

    throw new Error(`Unparseable gate assertion: ${assertion}`);
  }

  private parseLiteral(raw: string): unknown {
    const value = raw.trim();
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  private listRuns(limit: number): Array<{
    id: number;
    gate: string;
    pass: boolean;
    error?: string;
    durationMs: number;
    endpoint: string;
    runAt: string;
    iteration: number;
  }> {
    const lim = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 25;
    const rows = [...this.sql.exec(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`, lim)];
    return rows.map(row => ({
      id: row.id as number,
      gate: row.gate_name as string,
      pass: Number(row.pass) === 1,
      error: row.error as string | undefined ?? undefined,
      durationMs: row.duration_ms as number,
      endpoint: row.endpoint as string,
      runAt: row.run_at as string,
      iteration: row.loop_iteration as number,
    }));
  }

  private getSloSummary(): SloSummary {
    const all = [...this.sql.exec(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN pass = 1 THEN 1 ELSE 0 END) as passed,
         AVG(duration_ms) as avg_duration,
         MAX(run_at) as last_run_at
       FROM runs`
    )][0]!;
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const d24 = [...this.sql.exec(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN pass = 1 THEN 1 ELSE 0 END) as passed
       FROM runs
       WHERE run_at >= ?`,
      cutoff
    )][0]!;

    const total = Number(all.total ?? 0);
    const passed = Number(all.passed ?? 0);
    const total24 = Number(d24.total ?? 0);
    const passed24 = Number(d24.passed ?? 0);

    return {
      totalRuns: total,
      passRate: total === 0 ? 0 : Number(((passed / total) * 100).toFixed(2)),
      passRate24h: total24 === 0 ? 0 : Number(((passed24 / total24) * 100).toFixed(2)),
      averageDurationMs: total === 0 ? 0 : Number((Number(all.avg_duration ?? 0)).toFixed(2)),
      lastRunAt: all.last_run_at as string | undefined ?? undefined,
    };
  }

  private listLogs(limit: number): Array<{ ts: string; type: string; message: string; data?: unknown }> {
    const lim = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = [...this.sql.exec(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`, lim)];
    return rows.map(row => ({
      ts: row.ts as string,
      type: row.type as string,
      message: row.message as string,
      data: row.data ? JSON.parse(row.data as string) : undefined,
    }));
  }

  private broadcastLog(type: string, message: string, data?: Record<string, unknown>): void {
    const payload = {
      ts: new Date().toISOString(),
      type,
      message,
      data,
    };
    this.sql.exec(
      `INSERT INTO logs (ts, type, message, data) VALUES (?, ?, ?, ?)`,
      payload.ts,
      payload.type,
      payload.message,
      data ? JSON.stringify(data) : null
    );

    const encoded = JSON.stringify(payload);
    for (const socket of this.streamSockets) {
      try {
        socket.send(encoded);
      } catch {
        this.streamSockets.delete(socket);
      }
    }
  }

  private bumpIteration(): void {
    this.sql.exec(
      `UPDATE loop_state SET iteration = iteration + 1, last_run_at = ?`,
      new Date().toISOString()
    );
  }

  private getGateByName(name: string): Gate | undefined {
    const rows = [...this.sql.exec(`SELECT * FROM gates WHERE name = ?`, name)];
    if (rows.length === 0) {
      return undefined;
    }
    const row = rows[0]!;
    return {
      name: row.name as string,
      assertion: row.assertion as string,
      fn: row.fn as string | undefined ?? undefined,
      status: row.status as Gate["status"],
      lastError: row.last_error as string | undefined ?? undefined,
      iterations: row.iterations as number,
      order: row.order as number,
      dependsOn: row.depends_on as string | undefined ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private gateNameFromAssertion(assertion: string): string {
    return assertion
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private getConfigValue(key: string): string | undefined {
    const rows = [...this.sql.exec(`SELECT value FROM config WHERE key = ?`, key)];
    if (rows.length === 0) return undefined;
    return rows[0]!.value as string;
  }

  private setConfigValue(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, key, value);
  }

  private deleteConfigValue(key: string): void {
    this.sql.exec(`DELETE FROM config WHERE key = ?`, key);
  }

  private async hashValue(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  private async requireMutationAccess(request: Request): Promise<void> {
    this.enforceRateLimit(request);
    const summary = this.getAuthSummary();
    if (!summary.authEnabled) {
      return;
    }

    const explicitApiKey = request.headers.get("x-api-key")?.trim();
    const bearerToken = this.getBearerToken(request);
    const apiKey = explicitApiKey || (bearerToken && bearerToken.startsWith("glk_") ? bearerToken : undefined);

    if (apiKey) {
      const lookup = await this.lookupApiKey(apiKey);
      if (!lookup.found) {
        throw new HttpError(403, "AUTH_INVALID", "Invalid API key");
      }
      if (!this.scopeAllowsWrite(lookup.scope)) {
        throw new HttpError(403, "AUTH_FORBIDDEN_SCOPE", "API key lacks write scope");
      }
      if (lookup.tokenId !== undefined) {
        this.touchAuthToken(lookup.tokenId);
      }
      return;
    }

    if (summary.jwt.enabled && bearerToken) {
      const payload = await this.verifyJwtToken(bearerToken, summary.jwt);
      if (!this.jwtPayloadAllowsWrite(payload, summary.jwt.requiredScope)) {
        throw new HttpError(403, "AUTH_FORBIDDEN_SCOPE", "JWT lacks required scope");
      }
      return;
    }

    throw new HttpError(401, "AUTH_REQUIRED", "Missing credentials", "Provide x-api-key or Bearer token");
  }

  private getBearerToken(request: Request): string | undefined {
    const auth = request.headers.get("authorization");
    if (!auth) {
      return undefined;
    }
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return undefined;
    }
    return match[1]?.trim();
  }

  private hasApiKeyAuthEnabled(): boolean {
    const legacy = this.getConfigValue("apiKeyHash");
    const tokenCount = [...this.sql.exec(
      `SELECT COUNT(*) as c FROM auth_tokens WHERE revoked_at IS NULL`
    )][0]!.c as number;
    return legacy !== undefined || tokenCount > 0;
  }

  private getJwtSettings(): {
    enabled: boolean;
    jwksUrl?: string;
    issuer?: string;
    audience?: string;
    requiredScope: string;
  } {
    const jwksUrl = this.getConfigValue("authJwtJwksUrl")?.trim();
    const issuer = this.getConfigValue("authJwtIssuer")?.trim();
    const audience = this.getConfigValue("authJwtAudience")?.trim();
    const requiredScope = this.getConfigValue("authJwtRequiredScope")?.trim() || "greenlight:write";
    return {
      enabled: Boolean(jwksUrl),
      jwksUrl: jwksUrl || undefined,
      issuer: issuer || undefined,
      audience: audience || undefined,
      requiredScope,
    };
  }

  private getAuthSummary(): {
    authEnabled: boolean;
    methods: string[];
    apiTokens: { active: number; legacyPrimary: boolean };
    jwt: { enabled: boolean; jwksUrl?: string; issuer?: string; audience?: string; requiredScope: string };
  } {
    const active = [...this.sql.exec(
      `SELECT COUNT(*) as c FROM auth_tokens WHERE revoked_at IS NULL`
    )][0]!.c as number;
    const legacyPrimary = this.getConfigValue("apiKeyHash") !== undefined;
    const jwt = this.getJwtSettings();
    const methods: string[] = [];
    if (active > 0 || legacyPrimary) {
      methods.push("api_key");
    }
    if (jwt.enabled) {
      methods.push("jwt");
    }
    return {
      authEnabled: methods.length > 0,
      methods,
      apiTokens: { active, legacyPrimary },
      jwt,
    };
  }

  private validateAuthScope(scope: string): "read" | "write" | "admin" {
    if (scope === "read" || scope === "write" || scope === "admin") {
      return scope;
    }
    throw new HttpError(400, "BAD_SCOPE", "Scope must be read, write, or admin");
  }

  private generateApiToken(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const raw = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `glk_${raw}`;
  }

  private async createAuthToken(
    name: string,
    scope: "read" | "write" | "admin",
    providedApiKey?: string
  ): Promise<{ id: number; name: string; scope: string; apiKey: string; hash: string }> {
    const apiKey = providedApiKey ?? this.generateApiToken();
    const hash = await this.hashValue(apiKey);
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO auth_tokens (name, token_hash, scope, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
      name,
      hash,
      scope,
      now
    );
    const id = [...this.sql.exec(`SELECT last_insert_rowid() as id`)][0]!.id as number;
    return { id, name, scope, apiKey, hash };
  }

  private listAuthTokens(): Array<{
    id: number;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt?: string;
    revoked: boolean;
  }> {
    const rows = [...this.sql.exec(`SELECT * FROM auth_tokens ORDER BY id DESC`)];
    return rows.map(row => ({
      id: row.id as number,
      name: row.name as string,
      scope: row.scope as string,
      createdAt: row.created_at as string,
      lastUsedAt: row.last_used_at as string | undefined ?? undefined,
      revoked: Boolean(row.revoked_at),
    }));
  }

  private revokeAuthToken(id: number): boolean {
    const exists = [...this.sql.exec(`SELECT COUNT(*) as c FROM auth_tokens WHERE id = ?`, id)][0]!.c as number;
    if (exists === 0) {
      return false;
    }
    this.sql.exec(`UPDATE auth_tokens SET revoked_at = ? WHERE id = ?`, new Date().toISOString(), id);
    return true;
  }

  private revokeAuthTokenByHash(hash: string): number | undefined {
    const row = [...this.sql.exec(
      `SELECT id FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      hash
    )][0];
    if (!row) {
      return undefined;
    }
    const id = row.id as number;
    this.sql.exec(`UPDATE auth_tokens SET revoked_at = ? WHERE id = ?`, new Date().toISOString(), id);
    return id;
  }

  private touchAuthToken(id: number): void {
    this.sql.exec(`UPDATE auth_tokens SET last_used_at = ? WHERE id = ?`, new Date().toISOString(), id);
  }

  private async lookupApiKey(apiKey: string): Promise<{ found: boolean; scope: "read" | "write" | "admin"; tokenId?: number }> {
    const hash = await this.hashValue(apiKey);

    const tokenRows = [...this.sql.exec(
      `SELECT id, scope FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      hash
    )];
    if (tokenRows.length > 0) {
      const row = tokenRows[0]!;
      return {
        found: true,
        scope: this.validateAuthScope((row.scope as string).toLowerCase()),
        tokenId: row.id as number,
      };
    }

    const legacy = this.getConfigValue("apiKeyHash");
    if (legacy && legacy === hash) {
      return { found: true, scope: "admin" };
    }

    return { found: false, scope: "read" };
  }

  private scopeAllowsWrite(scope: "read" | "write" | "admin"): boolean {
    return scope === "write" || scope === "admin";
  }

  private async verifyJwtToken(
    token: string,
    jwt: { enabled: boolean; jwksUrl?: string; issuer?: string; audience?: string }
  ): Promise<JWTPayload> {
    if (!jwt.enabled || !jwt.jwksUrl) {
      throw new HttpError(401, "AUTH_REQUIRED", "JWT auth is not configured");
    }
    let jwks = this.jwtJwksCache.get(jwt.jwksUrl);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwt.jwksUrl));
      this.jwtJwksCache.set(jwt.jwksUrl, jwks);
    }
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: jwt.issuer,
        audience: jwt.audience,
      });
      return verified.payload;
    } catch {
      throw new HttpError(403, "AUTH_INVALID", "Invalid JWT");
    }
  }

  private jwtPayloadAllowsWrite(payload: JWTPayload, requiredScope: string): boolean {
    const collect = (value: unknown): string[] => {
      if (!value) return [];
      if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
      if (Array.isArray(value)) return value.filter(v => typeof v === "string") as string[];
      return [];
    };
    const scopes = [
      ...collect(payload.scope),
      ...collect((payload as Record<string, unknown>).scopes),
      ...collect((payload as Record<string, unknown>).permissions),
    ];
    return scopes.includes(requiredScope) || scopes.includes("greenlight:admin") || scopes.includes("admin");
  }

  private async buildAuthProof(): Promise<{
    authEnabled: boolean;
    methods: string[];
    checks: {
      anonymousMutationBlocked: boolean;
      apiKeyAuthEnabled: boolean;
      jwtConfigured: boolean;
    };
  }> {
    const summary = this.getAuthSummary();
    if (!summary.authEnabled) {
      return {
        authEnabled: false,
        methods: [],
        checks: {
          anonymousMutationBlocked: false,
          apiKeyAuthEnabled: false,
          jwtConfigured: false,
        },
      };
    }

    let anonymousBlocked = false;
    try {
      await this.requireMutationAccess(new Request("http://internal/auth-proof", {
        method: "POST",
        headers: { "x-forwarded-for": "auth-proof-anon" },
      }));
    } catch (err) {
      if (err instanceof HttpError && ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN_SCOPE"].includes(err.code)) {
        anonymousBlocked = true;
      }
    }

    return {
      authEnabled: true,
      methods: summary.methods,
      checks: {
        anonymousMutationBlocked: anonymousBlocked,
        apiKeyAuthEnabled: summary.apiTokens.active > 0 || summary.apiTokens.legacyPrimary,
        jwtConfigured: summary.jwt.enabled,
      },
    };
  }

  private enforceRateLimit(request: Request): void {
    const cfg = this.getConfig();
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const subject = request.headers.get("cf-connecting-ip")
      ?? request.headers.get("x-forwarded-for")
      ?? "anonymous";
    const bucket = `${subject}:${minute}`;

    const row = [...this.sql.exec(
      `SELECT count FROM rate_limits WHERE bucket = ?`,
      bucket
    )][0];

    if (!row) {
      this.sql.exec(
        `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)`,
        bucket,
        minute
      );
      return;
    }

    const count = row.count as number;
    if (count >= cfg.rateLimitPerMinute) {
      throw new HttpError(429, "RATE_LIMITED", "Rate limit exceeded", "Retry next minute");
    }
    this.sql.exec(`UPDATE rate_limits SET count = count + 1 WHERE bucket = ?`, bucket);
  }

  private async sendAlert(payload: Record<string, unknown>): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.alertWebhookUrl) {
      return;
    }
    const response = await fetch(cfg.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "greenlight",
        ts: new Date().toISOString(),
        ...payload,
      }),
    });
    if (!response.ok) {
      throw new Error(`Alert webhook failed with status ${response.status}`);
    }
  }

  private getOpenApiSpec(): Record<string, unknown> {
    return {
      openapi: "3.1.0",
      info: {
        title: "greenlight API",
        version: "0.0.1",
        description: "Contract-test any live endpoint. Gates go in red. Code comes out. Gates turn green.",
      },
      servers: [{ url: "/" }],
      paths: {
        "/gates": {
          get: {
            summary: "List all gates",
            description: "Returns a list of all gates with their current status and configuration.",
            responses: {
              "200": {
                description: "List of gates retrieved successfully",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                        result: {
                          type: "object",
                          properties: {
                            gates: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  name: { type: "string" },
                                  assertion: { type: "string" },
                                  status: { type: "string", enum: ["red", "green", "stuck"] },
                                  iterations: { type: "integer" },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            summary: "Add a new gate",
            description: "Create a new gate by providing an assertion in plain language.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["assertion"],
                    properties: {
                      assertion: {
                        type: "string",
                        description: "Plain language assertion, e.g., 'GET /health returns 200'",
                      },
                      name: {
                        type: "string",
                        description: "Optional custom name for the gate",
                      },
                    },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Gate created successfully",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                        result: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            assertion: { type: "string" },
                            status: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/status": {
          get: {
            summary: "Get loop status",
            description: "Returns the current state of the gate execution loop.",
            responses: {
              "200": {
                description: "Status retrieved successfully",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                        result: {
                          type: "object",
                          properties: {
                            loop: {
                              type: "object",
                              properties: {
                                status: { type: "string", enum: ["idle", "running", "paused"] },
                                iteration: { type: "integer" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/start": {
          post: {
            summary: "Start the loop",
            description: "Begin continuous gate execution.",
            responses: {
              "200": {
                description: "Loop started successfully",
              },
            },
          },
        },
        "/pause": {
          post: {
            summary: "Pause the loop",
            description: "Pause continuous gate execution.",
            responses: {
              "200": {
                description: "Loop paused successfully",
              },
            },
          },
        },
      },
    };
  }

  private renderAutoGeneratedDocs(): string {
    const spec = this.getOpenApiSpec();
    const paths = spec.paths as Record<string, Record<string, { 
      summary?: string; 
      description?: string;
      requestBody?: { content?: Record<string, { schema?: unknown }> };
      responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
    }>>;

    const formatSchema = (schema: unknown, indent = 0): string => {
      if (!schema || typeof schema !== 'object') return '';
      const s = schema as Record<string, unknown>;
      const spaces = '  '.repeat(indent);
      
      if (s.type === 'object' && s.properties) {
        const props = s.properties as Record<string, unknown>;
        let html = `${spaces}{\n`;
        for (const [key, val] of Object.entries(props)) {
          const v = val as Record<string, unknown>;
          if (v.type === 'object' && v.properties) {
            html += `${spaces}  "${key}": ${formatSchema(v, indent + 1).trimStart()},\n`;
          } else if (v.type === 'array' && v.items) {
            html += `${spaces}  "${key}": [${formatSchema(v.items, indent + 1).trimStart()}],\n`;
          } else {
            const typeStr = Array.isArray(v.type) ? v.type.join(' | ') : v.type;
            const enumVals = v.enum ? ` (${(v.enum as string[]).join(', ')})` : '';
            const desc = v.description ? ` // ${v.description}` : '';
            html += `${spaces}  "${key}": ${typeStr}${enumVals},${desc}\n`;
          }
        }
        html += `${spaces}}`;
        return html;
      } else if (s.type === 'array' && s.items) {
        return `${spaces}[${formatSchema(s.items, indent)}]`;
      }
      return `${spaces}${s.type || 'any'}`;
    };

    let endpointsHtml = '';
    let endpointId = 0;
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, details] of Object.entries(methods)) {
        endpointId++;
        const summary = details.summary || '';
        const description = details.description || '';
        const responseCodes = Object.entries(details.responses || {});

        let requestBodyHtml = '';
        if (details.requestBody?.content?.['application/json']?.schema) {
          const schema = details.requestBody.content['application/json'].schema;
          requestBodyHtml = `
          <div class="spec-section">
            <div class="spec-header">Request Body</div>
            <pre class="code-block">${formatSchema(schema)}</pre>
          </div>`;
        }

        let responseHtml = '';
        if (responseCodes.length > 0) {
          responseHtml = `
          <div class="spec-section">
            <div class="spec-header">Responses</div>`;
          for (const [code, resp] of responseCodes) {
            responseHtml += `
            <div class="response-item">
              <span class="response-code-badge">${code}</span>
              <span class="response-desc">${resp.description || ''}</span>`;
            if (resp.content?.['application/json']?.schema) {
              responseHtml += `
              <pre class="code-block">${formatSchema(resp.content['application/json'].schema)}</pre>`;
            }
            responseHtml += `</div>`;
          }
          responseHtml += `</div>`;
        }
        
        endpointsHtml += `
        <div class="endpoint" id="endpoint-${endpointId}">
          <div class="endpoint-header" onclick="toggleEndpoint(${endpointId})">
            <div class="method-path">
              <span class="method method-${method}">${method.toUpperCase()}</span>
              <code class="path">${path}</code>
            </div>
            <span class="toggle-icon">▼</span>
          </div>
          <div class="endpoint-content">
            ${summary ? `<div class="summary">${summary}</div>` : ''}
            ${description ? `<div class="description">${description}</div>` : ''}
            ${requestBodyHtml}
            ${responseHtml}
          </div>
        </div>`;
      }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${(spec.info as { title?: string }).title || 'API'} - ${(spec.info as { version?: string }).version || ''}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --fg: #111;
      --muted: #666;
      --border: #e5e5e5;
      --accent: #2563eb;
      --card: #fff;
      --code-bg: #f5f5f5;
      --get: #22c55e;
      --post: #3b82f6;
      --put: #f59e0b;
      --delete: #ef4444;
      --patch: #8b5cf6;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0a0a;
        --fg: #fafafa;
        --muted: #888;
        --border: #262626;
        --accent: #3b82f6;
        --card: #141414;
        --code-bg: #1a1a1a;
      }
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo { font-weight: 600; font-size: 1.125rem; }
    nav { display: flex; gap: 1.5rem; }
    nav a { color: var(--muted); text-decoration: none; font-size: 0.875rem; }
    nav a:hover { color: var(--fg); }
    main { max-width: 900px; margin: 0 auto; padding: 3rem 1.5rem; }
    .hero {
      text-align: center;
      margin-bottom: 3rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--border);
    }
    .hero h1 { font-size: 2rem; font-weight: 600; margin-bottom: 0.5rem; }
    .hero p { color: var(--muted); max-width: 600px; margin: 0 auto; }
    .endpoint {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      margin-bottom: 1rem;
      overflow: hidden;
    }
    .endpoint-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    .endpoint-header:hover { background: var(--code-bg); }
    .method-path {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .method {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      color: white;
    }
    .method-get { background: var(--get); }
    .method-post { background: var(--post); }
    .method-put { background: var(--put); }
    .method-delete { background: var(--delete); }
    .method-patch { background: var(--patch); }
    .path {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9375rem;
      font-weight: 500;
    }
    .toggle-icon {
      color: var(--muted);
      font-size: 0.75rem;
      transition: transform 0.2s;
    }
    .endpoint.collapsed .toggle-icon { transform: rotate(-90deg); }
    .endpoint-content {
      padding: 0 1.25rem 1.25rem;
      border-top: 1px solid var(--border);
    }
    .endpoint.collapsed .endpoint-content { display: none; }
    .summary {
      font-size: 1rem;
      font-weight: 500;
      margin: 1rem 0 0.5rem;
    }
    .description {
      font-size: 0.875rem;
      color: var(--muted);
      margin-bottom: 1rem;
    }
    .spec-section {
      margin-top: 1.25rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border);
    }
    .spec-header {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin-bottom: 0.75rem;
    }
    .code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8125rem;
      overflow-x: auto;
      white-space: pre;
      color: var(--fg);
    }
    .response-item {
      margin-bottom: 1rem;
    }
    .response-code-badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 600;
      font-family: ui-monospace, monospace;
      background: var(--border);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      margin-right: 0.5rem;
    }
    .response-desc {
      font-size: 0.875rem;
      color: var(--muted);
    }
    .response-item .code-block {
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">${(spec.info as { title?: string }).title || 'API'}</div>
    <nav>
      <a href="/">Home</a>
      <a href="https://github.com/acoyfellow/greenlight">GitHub</a>
    </nav>
  </header>

  <main>
    <div class="hero">
      <h1>${(spec.info as { title?: string }).title || 'API'}</h1>
      <p>${(spec.info as { description?: string }).description || ''}</p>
    </div>

    ${endpointsHtml}
  </main>

  <script>
    function toggleEndpoint(id) {
      const endpoint = document.getElementById('endpoint-' + id);
      endpoint.classList.toggle('collapsed');
    }
    // Collapse all by default
    document.querySelectorAll('.endpoint').forEach(e => e.classList.add('collapsed'));
  </script>
</body>
</html>`;
  }

  private renderDemoPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Demo</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 4rem; }
  </style>
</head>
<body>
  <h1>Demo</h1>
  <p>Interactive demo coming soon</p>
  <a href="/">Back to home</a>
</body>
</html>`;
  }

  private renderHomePage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>greenlight</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --fg: #111;
      --muted: #666;
      --border: #e5e5e5;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --card: #fff;
      --code-bg: #f5f5f5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0a0a;
        --fg: #fafafa;
        --muted: #888;
        --border: #262626;
        --accent: #3b82f6;
        --accent-hover: #2563eb;
        --card: #141414;
        --code-bg: #1a1a1a;
      }
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding: 1rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo { font-weight: 600; font-size: 1.125rem; }
    nav { display: flex; gap: 1.5rem; align-items: center; }
    nav a { color: var(--muted); text-decoration: none; font-size: 0.875rem; }
    nav a:hover { color: var(--fg); }
    .theme-toggle {
      background: none;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 0.375rem 0.75rem;
      border-radius: 0.375rem;
      cursor: pointer;
      font-size: 0.875rem;
    }
    .theme-toggle:hover { border-color: var(--muted); }
    main { max-width: 1100px; margin: 0 auto; padding: 4rem 1.5rem; }
    .hero {
      text-align: center;
      margin-bottom: 4rem;
    }
    .hero h1 {
      font-size: 3rem;
      font-weight: 600;
      line-height: 1.1;
      margin-bottom: 1rem;
      letter-spacing: -0.02em;
    }
    .hero p {
      color: var(--muted);
      font-size: 1.25rem;
      max-width: 600px;
      margin: 0 auto 1.5rem;
    }
    .cta {
      display: inline-flex;
      gap: 0.75rem;
      margin-bottom: 3rem;
    }
    .btn {
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.15s;
      border: none;
      cursor: pointer;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { border-color: var(--muted); }
    .tabs {
      display: flex;
      gap: 0.25rem;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    .tab {
      padding: 0.625rem 1rem;
      background: none;
      border: none;
      color: var(--muted);
      font-size: 0.875rem;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab.active {
      color: var(--fg);
      border-bottom-color: var(--accent);
    }
    .tab:hover { color: var(--fg); }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.875rem;
      overflow-x: auto;
      text-align: left;
    }
    .code-block code { color: var(--fg); }
    .features {
      display: grid;
      gap: 1.5rem;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      margin-top: 4rem;
    }
    .feature {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
    }
    .feature h3 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .feature p {
      font-size: 0.875rem;
      color: var(--muted);
      line-height: 1.5;
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 2rem 1.5rem;
      text-align: center;
      color: var(--muted);
      font-size: 0.875rem;
      margin-top: 4rem;
    }
    footer a { color: var(--fg); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <div class="logo">greenlight</div>
    <nav>
      <a href="/docs">API Reference</a>
      <a href="https://github.com/acoyfellow/greenlight">GitHub</a>
      <button class="theme-toggle" onclick="toggleTheme()">Theme</button>
    </nav>
  </header>

  <main>
    <div class="hero">
      <h1>Contract testing on the edge</h1>
      <p>Add assertions via API. Run them continuously in a Durable Object. Watch gates go from red to green. One SQLite database, zero containers.</p>
      <div class="cta">
        <a href="/docs" class="btn btn-primary">Get Started</a>
        <a href="https://github.com/acoyfellow/greenlight" class="btn btn-secondary">View on GitHub</a>
      </div>

      <div class="tabs">
        <button class="tab active" data-tab="curl" onclick="showTab('curl')">curl</button>
        <button class="tab" data-tab="js" onclick="showTab('js')">JavaScript</button>
        <button class="tab" data-tab="python" onclick="showTab('python')">Python</button>
      </div>

      <div id="curl" class="tab-content active">
        <pre class="code-block"><code># Add a gate
curl -X POST https://greenlight.coey.dev/gates \\
  -H "Content-Type: application/json" \\
  -d '{"assertion": "GET /health returns 200"}'

# Start the loop
curl -X POST https://greenlight.coey.dev/start

# Check status
curl https://greenlight.coey.dev/status</code></pre>
      </div>

      <div id="js" class="tab-content">
        <pre class="code-block"><code>// Add a gate
await fetch('/gates', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    assertion: 'GET /health returns 200'
  })
});

// Start the loop
await fetch('/start', { method: 'POST' });

// Check status
const status = await fetch('/status').then(r => r.json());</code></pre>
      </div>

      <div id="python" class="tab-content">
        <pre class="code-block"><code>import requests

# Add a gate
requests.post('/gates', json={
    'assertion': 'GET /health returns 200'
})

# Start the loop
requests.post('/start')

# Check status
status = requests.get('/status').json()</code></pre>
      </div>
    </div>

    <div class="features">
      <div class="feature">
        <h3>HTTP API</h3>
        <p>POST assertions as plain English. GET results as structured data. Everything is an endpoint.</p>
      </div>
      <div class="feature">
        <h3>Continuous Validation</h3>
        <p>Start a loop that runs gates on an interval. Store results in embedded SQLite. Check status anytime.</p>
      </div>
      <div class="feature">
        <h3>Cloudflare Native</h3>
        <p>One Durable Object. No servers to manage. Runs at the edge, close to your API.</p>
      </div>
      <div class="feature">
        <h3>Proof Export</h3>
        <p>Download complete gate history and reliability metrics. JSON bundles for CI/CD or compliance.</p>
      </div>
    </div>
  </main>

  <footer>
    <p>One Durable Object. One SQLite database. Zero containers. <a href="https://github.com/acoyfellow/greenlight">GitHub</a></p>
  </footer>

  <script>
    function showTab(tabId) {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function(t) {
        if (t.getAttribute('data-tab') === tabId) t.classList.add('active');
      });
      document.getElementById(tabId).classList.add('active');
    }

    function toggleTheme() {
      const html = document.documentElement;
      const current = html.style.colorScheme;
      html.style.colorScheme = current === 'dark' ? 'light' : 'dark';
    }
  </script>
</body>
</html>`;
  }
}
