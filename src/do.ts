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

function html200(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html;charset=UTF-8" },
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
  private streamSockets = new Set<WebSocket>();

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
        return html200(this.renderHomePage());
      }

      if (method === "GET" && path === "/stream") {
        const upgrade = request.headers.get("Upgrade");
        if (!upgrade || upgrade.toLowerCase() !== "websocket") {
          return json200(envelope("GET /stream", false, undefined, {
            message: "Expected websocket upgrade",
            code: "BAD_REQUEST",
          }, "Connect with a WebSocket client"), 426);
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        this.streamSockets.add(server);
        server.addEventListener("close", () => {
          this.streamSockets.delete(server);
        });
        server.addEventListener("error", () => {
          this.streamSockets.delete(server);
        });

        server.send(JSON.stringify({
          ts: new Date().toISOString(),
          type: "stream_connected",
          message: "Connected to greenlight stream",
        }));
        return new Response(null, { status: 101, webSocket: client });
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
        this.broadcastLog("gate_added", `Gate added: ${gate.name}`, {
          name: gate.name,
          status: gate.status,
        });

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
        this.broadcastLog("nudge_added", "Nudge added", { text });
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
        this.broadcastLog("loop_started", "Loop started", { status: state.status });
        return json200(envelope("POST /start", true, state, undefined, undefined, [
          { command: "GET /status", description: "Check status" },
          { command: "POST /pause", description: "Pause the loop" },
        ]));
      }

      if (method === "POST" && path === "/pause") {
        this.pauseLoop();
        const state = this.getLoopState();
        this.broadcastLog("loop_paused", "Loop paused", { status: state.status });
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
      this.broadcastLog("error", `Request failed: ${method} ${path}`, { error: msg });
      return json200(envelope(`${method} ${path}`, false, undefined, {
        message: msg,
        code: "INTERNAL_ERROR",
      }), 500);
    }
  }

  override async alarm(): Promise<void> {
    const state = this.getLoopState();
    if (state.status !== "running") {
      return;
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE loop_state SET iteration = iteration + 1, last_run_at = ?`,
      now
    );
    const iteration = [...this.sql.exec(`SELECT iteration FROM loop_state`)][0]!.iteration as number;
    this.broadcastLog(
      "loop_tick",
      "Loop tick complete; gate execution engine not implemented yet",
      { iteration }
    );

    const config = this.getConfig();
    this.ctx.storage.setAlarm(Date.now() + config.loopInterval * 1000);
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

  private broadcastLog(type: string, message: string, data?: Record<string, unknown>): void {
    if (this.streamSockets.size === 0) {
      return;
    }
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      message,
      data,
    });
    for (const socket of this.streamSockets) {
      try {
        socket.send(payload);
      } catch {
        this.streamSockets.delete(socket);
      }
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
    main { max-width: 980px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
    .card { background: #131a31; border: 1px solid #2a3359; border-radius: 12px; padding: 16px; }
    h1 { margin: 0 0 4px; font-size: 26px; }
    p { margin: 0; color: #aeb9e6; }
    form { display: flex; gap: 8px; margin-top: 10px; }
    input { flex: 1; min-width: 0; border-radius: 8px; border: 1px solid #36406d; background: #0c1330; color: #eff4ff; padding: 10px 12px; }
    button { border: 1px solid #3f4d86; background: #1c2750; color: #eff4ff; border-radius: 8px; padding: 10px 12px; cursor: pointer; font-weight: 600; }
    button:hover { background: #243366; }
    button:disabled { opacity: 0.6; cursor: wait; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .status { font-weight: 700; color: #7dd3fc; }
    .gates { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .gate { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid #2a3359; border-radius: 8px; background: #0f1734; }
    .dot { width: 10px; height: 10px; border-radius: 999px; flex: 0 0 10px; }
    .dot.red { background: #ef4444; }
    .dot.green { background: #22c55e; }
    .dot.stuck { background: #f59e0b; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; white-space: pre-wrap; margin: 0; max-height: 260px; overflow: auto; }
    .muted { color: #9aa7d8; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>greenlight</h1>
      <p>Add gates, send nudges, start or pause loop, watch live stream.</p>
    </section>

    <section class="card">
      <div class="row">
        <strong>Loop status: <span id="loopStatus" class="status">idle</span></strong>
        <button id="toggleLoopBtn" type="button">Start</button>
      </div>
      <form id="gateForm">
        <input id="gateInput" placeholder="GET /api/price returns 200" required />
        <button type="submit">Add gate</button>
      </form>
      <form id="nudgeForm">
        <input id="nudgeInput" placeholder="Use CoinGecko API" required />
        <button type="submit">Send nudge</button>
      </form>
    </section>

    <section class="card">
      <div class="row">
        <strong>Gates</strong>
        <span id="gateCount" class="muted">0</span>
      </div>
      <ul id="gatesList" class="gates"></ul>
    </section>

    <section class="card">
      <div class="row">
        <strong>Live log stream</strong>
        <span id="streamState" class="muted">connecting...</span>
      </div>
      <pre id="logPanel" class="mono"></pre>
    </section>
  </main>

  <script>
    (() => {
      const gateForm = document.getElementById("gateForm");
      const nudgeForm = document.getElementById("nudgeForm");
      const gateInput = document.getElementById("gateInput");
      const nudgeInput = document.getElementById("nudgeInput");
      const gatesList = document.getElementById("gatesList");
      const gateCount = document.getElementById("gateCount");
      const loopStatus = document.getElementById("loopStatus");
      const toggleLoopBtn = document.getElementById("toggleLoopBtn");
      const streamState = document.getElementById("streamState");
      const logPanel = document.getElementById("logPanel");

      const state = {
        loop: "idle",
        gates: [],
      };

      const addLog = (line) => {
        const stamp = new Date().toISOString();
        const next = "[" + stamp + "] " + line + "\\n";
        logPanel.textContent = next + logPanel.textContent;
        if (logPanel.textContent.length > 8000) {
          logPanel.textContent = logPanel.textContent.slice(0, 8000);
        }
      };

      const gateDot = (status) => {
        if (status === "green") return "green";
        if (status === "stuck") return "stuck";
        return "red";
      };

      const renderGates = () => {
        gatesList.innerHTML = "";
        gateCount.textContent = String(state.gates.length);
        for (const gate of state.gates) {
          const item = document.createElement("li");
          item.className = "gate";

          const dot = document.createElement("span");
          dot.className = "dot " + gateDot(gate.status);
          item.appendChild(dot);

          const text = document.createElement("span");
          text.textContent = gate.name + " - " + gate.assertion;
          item.appendChild(text);

          gatesList.appendChild(item);
        }
      };

      const renderLoop = () => {
        loopStatus.textContent = state.loop;
        toggleLoopBtn.textContent = state.loop === "running" ? "Pause" : "Start";
      };

      const request = async (path, init) => {
        const res = await fetch(path, init);
        const body = await res.json();
        if (!body.ok) {
          throw new Error(body.error && body.error.message ? body.error.message : "Request failed");
        }
        return body;
      };

      const refresh = async () => {
        const pair = await Promise.all([
          request("/gates"),
          request("/status"),
        ]);
        state.gates = pair[0].result.gates;
        state.loop = pair[1].result.loop.status;
        renderGates();
        renderLoop();
      };

      gateForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const assertion = gateInput.value.trim();
        if (!assertion) return;
        gateForm.querySelector("button").disabled = true;
        try {
          await request("/gates", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assertion }),
          });
          gateInput.value = "";
          await refresh();
        } catch (err) {
          addLog("gate add failed: " + String(err));
        } finally {
          gateForm.querySelector("button").disabled = false;
        }
      });

      nudgeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = nudgeInput.value.trim();
        if (!text) return;
        nudgeForm.querySelector("button").disabled = true;
        try {
          await request("/nudge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          nudgeInput.value = "";
        } catch (err) {
          addLog("nudge failed: " + String(err));
        } finally {
          nudgeForm.querySelector("button").disabled = false;
        }
      });

      toggleLoopBtn.addEventListener("click", async () => {
        toggleLoopBtn.disabled = true;
        try {
          const command = state.loop === "running" ? "/pause" : "/start";
          await request(command, { method: "POST" });
          await refresh();
        } catch (err) {
          addLog("loop toggle failed: " + String(err));
        } finally {
          toggleLoopBtn.disabled = false;
        }
      });

      const streamProtocol = location.protocol === "https:" ? "wss:" : "ws:";
      const streamURL = streamProtocol + "//" + location.host + "/stream";
      const socket = new WebSocket(streamURL);
      socket.addEventListener("open", () => {
        streamState.textContent = "connected";
        addLog("stream connected");
      });
      socket.addEventListener("close", () => {
        streamState.textContent = "closed";
        addLog("stream closed");
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
