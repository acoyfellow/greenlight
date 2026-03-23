import { DurableObject } from "cloudflare:workers";
import type { Gate, Memory, Nudge, LoopState, Config, Envelope } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

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

export interface Env {
  GREENLIGHT_DO: DurableObjectNamespace<GreenlightDO>;
  AI: Ai;
}

/**
 * The greenlight Durable Object.
 * One DO per project. SQLite for everything.
 */
export class GreenlightDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
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
    const count = [...this.sql.exec(`SELECT COUNT(*) as c FROM loop_state`)][0]!.c as number;
    if (count === 0) {
      this.sql.exec(`INSERT INTO loop_state (status, iteration) VALUES ('idle', 0)`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (method === "GET" && path === "/") {
        return new Response(
          `<!DOCTYPE html><html><head><title>greenlight</title></head><body><h1>greenlight</h1></body></html>`,
          { headers: { "content-type": "text/html;charset=UTF-8" } }
        );
      }

      if (method === "POST" && path === "/gates") {
        const json = await request.json() as Record<string, unknown>;
        const assertion = json.assertion as string | undefined;
        const fn = json.fn as string | undefined;
        const name = json.name as string | undefined;

        if (!assertion && !fn) {
          return json200(envelope("POST /gates", false, undefined, {
            message: "Either 'assertion' or 'fn' is required",
            code: "MISSING_FIELD",
          }, "Provide an 'assertion' string or a 'fn' function body"), 400);
        }

        const gate = fn
          ? this.addGate(name ?? assertion ?? "custom", fn)
          : this.addGate(assertion!);

        return json200(envelope("POST /gates", true, gate, undefined, undefined, [
          { command: "GET /gates", description: "List all gates" },
          { command: "POST /start", description: "Start the loop" },
        ]));
      }

      if (method === "GET" && path === "/gates") {
        const gates = this.listGates();
        return json200(envelope("GET /gates", true, { gates }, undefined, undefined, [
          { command: "POST /gates", description: "Add a gate" },
          { command: "POST /start", description: "Start the loop" },
        ]));
      }

      if (method === "DELETE" && path.startsWith("/gates/")) {
        const name = path.slice("/gates/".length);
        const removed = this.removeGate(decodeURIComponent(name));
        if (!removed) {
          return json200(envelope(`DELETE /gates/${name}`, false, undefined, {
            message: "Gate not found",
            code: "NOT_FOUND",
          }), 404);
        }
        return json200(envelope(`DELETE /gates/${name}`, true, { removed: true }, undefined, undefined, [
          { command: "GET /gates", description: "List remaining gates" },
        ]));
      }

      if (method === "POST" && path === "/nudge") {
        const json = await request.json() as Record<string, unknown>;
        const text = json.text as string | undefined;
        if (!text) {
          return json200(envelope("POST /nudge", false, undefined, {
            message: "'text' is required",
            code: "MISSING_FIELD",
          }, "Provide a 'text' string"), 400);
        }
        const nudge = this.addNudge(text);
        return json200(envelope("POST /nudge", true, nudge, undefined, undefined, [
          { command: "GET /status", description: "Check loop status" },
        ]));
      }

      if (method === "GET" && path === "/status") {
        const loop = this.getLoopState();
        const gates = this.listGates();
        const summary = {
          total: gates.length,
          red: gates.filter(g => g.status === "red").length,
          green: gates.filter(g => g.status === "green").length,
          stuck: gates.filter(g => g.status === "stuck").length,
        };
        return json200(envelope("GET /status", true, { loop, gates: summary }, undefined, undefined, [
          { command: "POST /start", description: "Start the loop" },
          { command: "POST /gates", description: "Add a gate" },
        ]));
      }

      if (method === "POST" && path === "/start") {
        this.startLoop();
        const state = this.getLoopState();
        return json200(envelope("POST /start", true, state, undefined, undefined, [
          { command: "GET /status", description: "Check status" },
          { command: "POST /pause", description: "Pause the loop" },
        ]));
      }

      if (method === "POST" && path === "/pause") {
        this.pauseLoop();
        const state = this.getLoopState();
        return json200(envelope("POST /pause", true, state, undefined, undefined, [
          { command: "POST /start", description: "Resume the loop" },
          { command: "GET /status", description: "Check status" },
        ]));
      }

      return json200(envelope(`${method} ${path}`, false, undefined, {
        message: "Not found",
        code: "NOT_FOUND",
      }), 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json200(envelope(`${method} ${path}`, false, undefined, {
        message: msg,
        code: "INTERNAL_ERROR",
      }), 500);
    }
  }

  override async alarm(): Promise<void> {
    this.sql.exec(
      `UPDATE loop_state SET iteration = iteration + 1, last_run_at = ?`,
      new Date().toISOString()
    );
  }

  // --- Gate CRUD ---

  addGate(assertion: string, fn?: string): Gate {
    const now = new Date().toISOString();
    let name: string;

    if (fn) {
      name = assertion;
    } else {
      name = assertion
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    const maxOrder = [...this.sql.exec(`SELECT MAX("order") as m FROM gates`)][0]!.m as number | null;
    const order = (maxOrder ?? -1) + 1;

    this.sql.exec(
      `INSERT INTO gates (name, assertion, fn, status, iterations, "order", created_at, updated_at)
       VALUES (?, ?, ?, 'red', 0, ?, ?, ?)`,
      name, assertion, fn ?? null, order, now, now
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

  // --- Gate Execution ---

  async runGates(_endpoint: string): Promise<import("./types.js").GateResult[]> {
    throw new Error("not implemented");
  }

  // --- Memory ---

  recordMemory(trigger: string, learning: string, source: Memory["source"]): Memory {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO memories (trigger, learning, source, created_at) VALUES (?, ?, ?, ?)`,
      trigger, learning, source, now
    );
    const row = [...this.sql.exec(`SELECT last_insert_rowid() as id`)][0]!;
    const id = row.id as number;
    this.sql.exec(
      `INSERT INTO memories_fts (rowid, trigger, learning) VALUES (?, ?, ?)`,
      id, trigger, learning
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
      search, lim
    )];
    return rows.map(r => ({
      id: r.id as number,
      trigger: r.trigger as string,
      learning: r.learning as string,
      source: r.source as Memory["source"],
      createdAt: r.created_at as string,
    }));
  }

  // --- Nudges ---

  addNudge(text: string): Nudge {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO nudges (text, consumed, created_at) VALUES (?, 0, ?)`,
      text, now
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

  // --- Config ---

  getConfig(): Config {
    const rows = [...this.sql.exec(`SELECT key, value FROM config`)];
    const overrides: Record<string, string> = {};
    for (const r of rows) {
      overrides[r.key as string] = r.value as string;
    }
    return {
      model: overrides.model ?? DEFAULT_CONFIG.model,
      maxIterations: overrides.maxIterations !== undefined ? Number(overrides.maxIterations) : DEFAULT_CONFIG.maxIterations,
      loopInterval: overrides.loopInterval !== undefined ? Number(overrides.loopInterval) : DEFAULT_CONFIG.loopInterval,
      autoPublish: overrides.autoPublish !== undefined ? overrides.autoPublish === "true" : DEFAULT_CONFIG.autoPublish,
    };
  }

  setConfig(key: keyof Config, value: Config[keyof Config]): void {
    const validKeys: ReadonlyArray<string> = ["model", "maxIterations", "loopInterval", "autoPublish"];
    if (!validKeys.includes(key)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`,
      key, String(value)
    );
  }

  // --- Loop ---

  getLoopState(): LoopState {
    const row = [...this.sql.exec(`SELECT * FROM loop_state`)][0]!;
    return {
      status: row.status as LoopState["status"],
      iteration: row.iteration as number,
      lastRunAt: row.last_run_at as string | undefined ?? undefined,
    };
  }

  startLoop(): void {
    const gates = this.listGates();
    if (gates.length === 0) {
      throw new Error("Cannot start loop without gates");
    }
    this.sql.exec(`UPDATE loop_state SET status = 'running'`);
    const config = this.getConfig();
    this.ctx.storage.setAlarm(Date.now() + config.loopInterval * 1000);
  }

  pauseLoop(): void {
    const state = this.getLoopState();
    if (state.status !== "running") {
      throw new Error("Cannot pause: loop is not running");
    }
    this.sql.exec(`UPDATE loop_state SET status = 'paused'`);
    this.ctx.storage.deleteAlarm();
  }
}
