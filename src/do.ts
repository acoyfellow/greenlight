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
      if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && c.req.path !== "/auth/bootstrap") {
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
      const token = await this.createAuthToken(`rotated-${Date.now()}`, "admin", apiKey);
      this.setConfigValue("apiKeyHash", token.hash);
      this.broadcastLog("auth_rotated", "Primary API key rotated", { tokenId: token.id });
      return json200(envelope(command, true, {
        rotated: true,
        apiKey,
        token: { id: token.id, name: token.name, scope: token.scope },
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
      const results = await this.runGates(endpoint);
      this.broadcastLog("manual_run", "Manual run completed", { endpoint, gates: results.length });
      return json200(envelope(command, true, { endpoint, results, slo: this.getSloSummary() }));
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
      return json200(envelope(command, true, { gates: this.listGates() }, undefined, undefined, [
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
      return json200(envelope(command, true, { loop, gates: summary }, undefined, undefined, [
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
      const results = await this.runGates(endpoint);
      const gates = this.listGates();
      const hasStuck = gates.some(g => g.status === "stuck");
      const allGreen = gates.length > 0 && gates.every(g => g.status === "green");

      if (allGreen) {
        this.sql.exec(`UPDATE loop_state SET status = 'done'`);
        this.ctx.storage.deleteAlarm();
        this.broadcastLog("loop_done", "All gates green", { gates: gates.length });
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
      const attempts = gate.iterations + 1;
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

  private async executeGate(gate: Gate, endpoint: string): Promise<void> {
    if (gate.fn) {
      throw new Error("Custom function gates are not supported in runtime mode");
    }
    await this.executeAssertionGate(gate.assertion, endpoint);
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

  private renderHomePage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>greenlight</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
    body { margin: 0; background: #0b1020; color: #dbe4ff; }
    main { max-width: 1200px; margin: 0 auto; padding: 24px; display: grid; gap: 14px; }
    .card { background: #111a33; border: 1px solid #28345f; border-radius: 12px; padding: 14px; }
    .header { display: grid; gap: 8px; }
    h1 { margin: 0; font-size: 28px; }
    p { margin: 0; color: #aab6df; }
    .muted { color: #8ea0d8; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .controls { display: flex; gap: 8px; flex-wrap: wrap; }
    form { display: flex; gap: 8px; margin-top: 8px; }
    input, select { flex: 1; min-width: 0; border-radius: 8px; border: 1px solid #34467a; background: #0b1431; color: #eef3ff; padding: 10px; }
    button { border: 1px solid #3e5190; background: #1b2a59; color: #eef3ff; border-radius: 8px; padding: 10px 12px; cursor: pointer; font-weight: 600; }
    button:hover { background: #253977; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .gates, .runs, .templates { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
    .item { border: 1px solid #263359; border-radius: 8px; padding: 8px; background: #0d1838; display: flex; gap: 8px; align-items: center; }
    .dot { width: 10px; height: 10px; border-radius: 999px; flex: 0 0 10px; }
    .dot.red { background: #ef4444; }
    .dot.green { background: #22c55e; }
    .dot.stuck { background: #f59e0b; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; white-space: pre-wrap; margin: 0; max-height: 240px; overflow: auto; }
    .chip { border: 1px solid #32467d; border-radius: 999px; padding: 4px 8px; font-size: 12px; }
    .ok { color: #86efac; }
    .bad { color: #fda4af; }
  </style>
</head>
<body>
  <main>
    <section class="card header">
      <h1>Contract-test any live endpoint in 60 seconds.</h1>
      <p>Define gates, watch regressions go red, recover to green, export proof.</p>
      <div class="row">
        <div class="controls">
          <span id="projectLabel" class="chip">project: default</span>
          <span id="passRateChip" class="chip">pass 24h: 0%</span>
          <span id="proofFreshnessChip" class="chip">proof: never</span>
          <span id="streamState" class="chip">stream: connecting</span>
        </div>
        <div class="controls">
          <button id="demoCtaBtn" type="button">Run 60-second demo</button>
          <button id="proofBtn" type="button">See proof JSON</button>
        </div>
      </div>
      <div class="muted">1) Bootstrap demo gates 2) Break endpoint 3) Recover + proof.</div>
    </section>

    <section class="card">
      <form id="gateForm">
        <input id="gateInput" placeholder="GET /demo/health returns 200" required />
        <button type="submit">Add gate</button>
      </form>
      <form id="nudgeForm">
        <input id="nudgeInput" placeholder="Use deterministic response schema" required />
        <button type="submit">Send nudge</button>
      </form>
      <div class="row" style="margin-top:8px;">
        <div class="controls">
          <button id="toggleLoopBtn" type="button">Start</button>
          <button id="runNowBtn" type="button">Run now</button>
          <button id="bootstrapDemoBtn" type="button">Bootstrap demo gates</button>
          <button id="toggleDemoFailureBtn" type="button">Break demo endpoint</button>
        </div>
        <span id="gateCount" class="muted">gates: 0</span>
      </div>
      <form id="apiKeyForm">
        <input id="apiKeyInput" placeholder="Optional API key (x-api-key)" />
        <button type="submit">Save key</button>
      </form>
      <div class="muted" id="authState">auth: unknown</div>
    </section>

    <section class="grid">
      <section class="card">
        <div class="row">
          <strong>Gates</strong>
        </div>
        <ul id="gatesList" class="gates"></ul>
      </section>
      <section class="card">
        <div class="row">
          <strong>Templates</strong>
        </div>
        <ul id="templateList" class="templates"></ul>
      </section>
    </section>

    <section class="grid">
      <section class="card">
        <div class="row">
          <strong>Recent runs</strong>
          <span id="runCount" class="muted">0</span>
        </div>
        <ul id="runList" class="runs"></ul>
      </section>
      <section class="card">
        <div class="row">
          <strong>SLO dashboard</strong>
        </div>
        <div id="sloPanel" class="mono"></div>
      </section>
    </section>

    <section class="card">
      <div class="row">
        <strong>Live log stream</strong>
      </div>
      <pre id="logPanel" class="mono"></pre>
    </section>
  </main>

  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const project = params.get("project") || "default";
      const scopedSuffix = location.search ? (location.search.startsWith("?") ? location.search : "?" + location.search) : "";

      const state = {
        project,
        loop: "idle",
        gates: [],
        runs: [],
        templates: [],
        demoFailureMode: false,
        slo: null,
        authEnabled: false,
        lastProofAt: localStorage.getItem("greenlight_last_proof_at") || "",
        apiKey: localStorage.getItem("greenlight_api_key") || "",
      };

      const $ = (id) => document.getElementById(id);
      const gateForm = $("gateForm");
      const nudgeForm = $("nudgeForm");
      const apiKeyForm = $("apiKeyForm");
      const gateInput = $("gateInput");
      const nudgeInput = $("nudgeInput");
      const apiKeyInput = $("apiKeyInput");
      const gatesList = $("gatesList");
      const gateCount = $("gateCount");
      const runList = $("runList");
      const runCount = $("runCount");
      const sloPanel = $("sloPanel");
      const logPanel = $("logPanel");
      const streamState = $("streamState");
      const projectLabel = $("projectLabel");
      const passRateChip = $("passRateChip");
      const proofFreshnessChip = $("proofFreshnessChip");
      const authState = $("authState");
      const templateList = $("templateList");
      const demoCtaBtn = $("demoCtaBtn");
      const toggleLoopBtn = $("toggleLoopBtn");
      const toggleDemoFailureBtn = $("toggleDemoFailureBtn");
      const runNowBtn = $("runNowBtn");
      const bootstrapDemoBtn = $("bootstrapDemoBtn");
      const proofBtn = $("proofBtn");

      apiKeyInput.value = state.apiKey;
      projectLabel.textContent = "project: " + state.project;

      const scopedPath = (path) => path + (scopedSuffix ? (path.includes("?") ? "&" : "?") + scopedSuffix.slice(1) : "");

      const authHeaders = (contentType) => {
        const headers = {};
        if (contentType) headers["content-type"] = contentType;
        if (state.apiKey) headers["x-api-key"] = state.apiKey;
        return headers;
      };

      const addLog = (line) => {
        const stamp = new Date().toISOString();
        const next = "[" + stamp + "] " + line + "\\n";
        logPanel.textContent = next + logPanel.textContent;
        if (logPanel.textContent.length > 14000) {
          logPanel.textContent = logPanel.textContent.slice(0, 14000);
        }
      };

      const gateDot = (status) => {
        if (status === "green") return "green";
        if (status === "stuck") return "stuck";
        return "red";
      };

      const request = async (path, init = {}) => {
        const res = await fetch(scopedPath(path), init);
        const body = await res.json();
        if (!body.ok) throw new Error(body.error && body.error.message ? body.error.message : "request failed");
        return body;
      };

      const relativeAge = (iso) => {
        if (!iso) return "never";
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return "never";
        const diff = Math.max(0, Date.now() - then);
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "<1m ago";
        if (mins < 60) return mins + "m ago";
        return Math.floor(mins / 60) + "h ago";
      };

      const renderGates = () => {
        gatesList.innerHTML = "";
        gateCount.textContent = "gates: " + state.gates.length;
        for (const gate of state.gates) {
          const li = document.createElement("li");
          li.className = "item";
          const dot = document.createElement("span");
          dot.className = "dot " + gateDot(gate.status);
          li.appendChild(dot);
          const span = document.createElement("span");
          span.textContent = gate.name + " - " + gate.assertion;
          li.appendChild(span);
          gatesList.appendChild(li);
        }
      };

      const renderRuns = () => {
        runList.innerHTML = "";
        runCount.textContent = String(state.runs.length);
        for (const run of state.runs) {
          const li = document.createElement("li");
          li.className = "item";
          const dot = document.createElement("span");
          dot.className = "dot " + (run.pass ? "green" : "red");
          li.appendChild(dot);
          const span = document.createElement("span");
          span.textContent = run.gate + " - " + (run.pass ? "pass" : "fail") + " - " + run.durationMs + "ms";
          li.appendChild(span);
          runList.appendChild(li);
        }
      };

      const renderTemplates = () => {
        templateList.innerHTML = "";
        for (const template of state.templates) {
          const li = document.createElement("li");
          li.className = "item";
          const title = document.createElement("span");
          title.textContent = template.assertion;
          li.appendChild(title);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "Use";
          btn.addEventListener("click", async () => {
            gateInput.value = template.assertion;
            gateInput.focus();
          });
          li.appendChild(btn);
          templateList.appendChild(li);
        }
      };

      const renderSlo = () => {
        if (!state.slo) {
          sloPanel.textContent = "No runs yet.";
          return;
        }
        sloPanel.textContent =
          "total runs: " + state.slo.totalRuns + "\\n" +
          "pass rate: " + state.slo.passRate + "%\\n" +
          "pass rate 24h: " + state.slo.passRate24h + "%\\n" +
          "avg duration: " + state.slo.averageDurationMs + "ms\\n" +
          "last run: " + (state.slo.lastRunAt || "never");
      };

      const renderHeader = () => {
        passRateChip.textContent = "pass 24h: " + (state.slo ? state.slo.passRate24h : 0) + "%";
        proofFreshnessChip.textContent = "proof: " + relativeAge(state.lastProofAt);
        toggleLoopBtn.textContent = state.loop === "running" ? "Pause" : "Start";
        toggleDemoFailureBtn.textContent = state.demoFailureMode ? "Fix demo endpoint" : "Break demo endpoint";
        authState.textContent = "auth: " + (state.authEnabled ? "enabled" : "disabled");
      };

      const refresh = async () => {
        const [statusBody, gatesBody, runsBody, sloBody, templateBody, configBody, authBody, logsBody] = await Promise.all([
          request("/status"),
          request("/gates"),
          request("/runs?limit=12"),
          request("/slo"),
          request("/templates"),
          request("/config"),
          request("/auth/status"),
          request("/logs?limit=35"),
        ]);

        state.loop = statusBody.result.loop.status;
        state.gates = gatesBody.result.gates;
        state.runs = runsBody.result.runs;
        state.slo = sloBody.result.slo;
        state.templates = templateBody.result.templates;
        state.demoFailureMode = Boolean(configBody.result.config.demoFailureMode);
        state.authEnabled = Boolean(authBody.result.authEnabled);

        renderHeader();
        renderGates();
        renderRuns();
        renderTemplates();
        renderSlo();

        const existing = logsBody.result.logs || [];
        if (!logPanel.textContent) {
          for (const log of existing.reverse()) {
            addLog(log.type + ": " + log.message);
          }
        }
      };

      gateForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const assertion = gateInput.value.trim();
        if (!assertion) return;
        try {
          await request("/gates", {
            method: "POST",
            headers: authHeaders("application/json"),
            body: JSON.stringify({ assertion }),
          });
          gateInput.value = "";
          await refresh();
        } catch (err) {
          addLog("gate add failed: " + String(err));
        }
      });

      nudgeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = nudgeInput.value.trim();
        if (!text) return;
        try {
          await request("/nudge", {
            method: "POST",
            headers: authHeaders("application/json"),
            body: JSON.stringify({ text }),
          });
          nudgeInput.value = "";
        } catch (err) {
          addLog("nudge failed: " + String(err));
        }
      });

      apiKeyForm.addEventListener("submit", (event) => {
        event.preventDefault();
        state.apiKey = apiKeyInput.value.trim();
        localStorage.setItem("greenlight_api_key", state.apiKey);
        addLog("api key saved in browser storage");
      });

      demoCtaBtn.addEventListener("click", async () => {
        demoCtaBtn.disabled = true;
        try {
          await request("/demo/bootstrap", { method: "POST", headers: authHeaders() });
          await request("/run", { method: "POST", headers: authHeaders() });
          await refresh();
          addLog("60-second demo completed");
        } catch (err) {
          addLog("60-second demo failed: " + String(err));
        } finally {
          demoCtaBtn.disabled = false;
        }
      });

      toggleLoopBtn.addEventListener("click", async () => {
        try {
          await request(state.loop === "running" ? "/pause" : "/start", {
            method: "POST",
            headers: authHeaders(),
          });
          await refresh();
        } catch (err) {
          addLog("loop toggle failed: " + String(err));
        }
      });

      runNowBtn.addEventListener("click", async () => {
        try {
          await request("/run", { method: "POST", headers: authHeaders() });
          await refresh();
        } catch (err) {
          addLog("run now failed: " + String(err));
        }
      });

      bootstrapDemoBtn.addEventListener("click", async () => {
        try {
          await request("/demo/bootstrap", {
            method: "POST",
            headers: authHeaders(),
          });
          await refresh();
        } catch (err) {
          addLog("bootstrap failed: " + String(err));
        }
      });

      toggleDemoFailureBtn.addEventListener("click", async () => {
        try {
          await request("/demo/failure", {
            method: "POST",
            headers: authHeaders("application/json"),
            body: JSON.stringify({ enabled: !state.demoFailureMode }),
          });
          await refresh();
        } catch (err) {
          addLog("toggle demo failure failed: " + String(err));
        }
      });

      proofBtn.addEventListener("click", async () => {
        try {
          const proof = await request("/proof");
          const blob = new Blob([JSON.stringify(proof.result, null, 2)], { type: "application/json" });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = "greenlight-proof-" + state.project + ".json";
          link.click();
          URL.revokeObjectURL(link.href);
          state.lastProofAt = new Date().toISOString();
          localStorage.setItem("greenlight_last_proof_at", state.lastProofAt);
          renderHeader();
          addLog("proof bundle downloaded");
        } catch (err) {
          addLog("proof download failed: " + String(err));
        }
      });

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const streamUrl = protocol + "//" + location.host + scopedPath("/stream");
      const socket = new WebSocket(streamUrl);
      socket.addEventListener("open", () => {
        streamState.textContent = "stream: connected";
      });
      socket.addEventListener("close", () => {
        streamState.textContent = "stream: closed";
      });
      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          addLog(data.type + ": " + data.message);
        } catch {
          addLog(String(event.data));
        }
      });

      refresh().catch((err) => addLog("initial load failed: " + String(err)));
    })();
  </script>
</body>
</html>`;
  }
}
