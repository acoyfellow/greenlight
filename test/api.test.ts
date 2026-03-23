import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import type { Envelope, Gate, LoopState } from "../src/types.js";

// NOTE: API tests share a single DO ("default") via the Worker entrypoint.
// Tests should be independent of gate state where possible,
// or explicitly set up their own preconditions.

describe("HTTP API", () => {
  describe("GET /", () => {
    it("returns HTML UI", async () => {
      const res = await SELF.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("id=\"gateForm\"");
      expect(html).toContain("id=\"nudgeForm\"");
      expect(html).toContain("id=\"gatesList\"");
      expect(html).toContain("id=\"logPanel\"");
      expect(html).toContain("id=\"toggleLoopBtn\"");
    });

    it("keeps /p/<project> prefix when frontend builds API paths", async () => {
      const project = `path-ui-${Date.now()}`;
      const res = await SELF.fetch(`http://localhost/p/${project}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("const pathParts = location.pathname.split(\"/\").filter(Boolean);");
      expect(html).toContain("const projectPrefix = pathProject ? \"/p/\" + encodeURIComponent(pathProject) : \"\";");
      expect(html).toContain("const withPrefix = projectPrefix ? projectPrefix + normalized : normalized;");
    });
  });

  describe("GET /stream", () => {
    it("rejects non-websocket request", async () => {
      const res = await SELF.fetch("http://localhost/stream");
      expect(res.status).toBe(426);
      const body = (await res.json()) as Envelope;
      expect(body.ok).toBe(false);
      expect(body.command).toBe("GET /stream");
      expect(body.error?.code).toBe("BAD_REQUEST");
    });
  });

  describe("POST /gates", () => {
    it("adds a gate and returns envelope", async () => {
      const res = await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/health returns 200" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<Gate>;
      expect(body.ok).toBe(true);
      expect(body.command).toBe("POST /gates");
      expect(body.result?.name).toBeTruthy();
      expect(body.result?.status).toBe("red");
      expect(body.next_actions.length).toBeGreaterThan(0);
    });

    it("adds a custom function gate", async () => {
      const res = await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "custom-check",
          fn: "export default async (endpoint) => { await fetch(endpoint); }",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<Gate>;
      expect(body.ok).toBe(true);
      expect(body.result?.name).toBe("custom-check");
    });

    it("executes a custom function gate during run", async () => {
      const project = `fn-${Date.now()}`;
      const fn = `
export default async (endpoint) => {
  const price = await fetch("data:application/json,%7B%22currency%22%3A%22USD%22%7D");
  if (price.status !== 200) throw new Error("price failed");
  const body = await price.json();
  if (body.currency !== "USD") throw new Error("currency failed");
}
      `.trim();

      const add = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "fn-gate", fn }),
      });
      expect(add.status).toBe(200);

      const run = await SELF.fetch(`http://localhost/run?project=${project}`, { method: "POST" });
      expect(run.status).toBe(200);

      const runs = await SELF.fetch(`http://localhost/runs?project=${project}&limit=5`);
      const runsBody = (await runs.json()) as Envelope<{
        runs: Array<{ gate: string; pass: boolean; error?: string }>;
      }>;
      const match = runsBody.result?.runs.find(r => r.gate === "fn-gate");
      expect(match?.pass).toBe(true);
      expect(match?.error).toBeUndefined();
    });

    it("rejects missing assertion and fn", async () => {
      const res = await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.ok).toBe(false);
      expect(body.error?.message).toBeTruthy();
      expect(body.fix).toBeTruthy();
    });
  });

  describe("GET /gates", () => {
    it("lists gates with status", async () => {
      const res = await SELF.fetch("http://localhost/gates");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ gates: Gate[] }>;
      expect(body.ok).toBe(true);
      expect(body.command).toBe("GET /gates");
      expect(Array.isArray(body.result?.gates)).toBe(true);
    });
  });

  describe("DELETE /gates/:name", () => {
    it("removes an existing gate", async () => {
      // Add a gate with a unique name
      await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/delete-test returns 200" }),
      });

      const res = await SELF.fetch("http://localhost/gates/get-api-delete-test-returns-200", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ removed: boolean }>;
      expect(body.ok).toBe(true);
      expect(body.result?.removed).toBe(true);
    });

    it("returns 404 for non-existent gate", async () => {
      const res = await SELF.fetch("http://localhost/gates/does-not-exist", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Envelope;
      expect(body.ok).toBe(false);
    });
  });

  describe("POST /nudge", () => {
    it("adds a nudge", async () => {
      const res = await SELF.fetch("http://localhost/nudge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Use CoinGecko" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope;
      expect(body.ok).toBe(true);
      expect(body.command).toBe("POST /nudge");
    });

    it("rejects empty nudge", async () => {
      const res = await SELF.fetch("http://localhost/nudge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.ok).toBe(false);
    });
  });

  describe("GET /status", () => {
    it("returns loop state and gate summary", async () => {
      const res = await SELF.fetch("http://localhost/status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{
        loop: LoopState;
        gates: { total: number; red: number; green: number; stuck: number };
      }>;
      expect(body.ok).toBe(true);
      expect(body.command).toBe("GET /status");
      expect(body.result?.loop).toBeTruthy();
      expect(body.result?.gates).toBeTruthy();
      expect(typeof body.result?.gates.total).toBe("number");
    });
  });

  describe("POST /start", () => {
    it("starts the loop when gates exist", async () => {
      // Ensure at least one gate
      await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/start-test returns 200" }),
      });

      const res = await SELF.fetch("http://localhost/start", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<LoopState>;
      expect(body.ok).toBe(true);
      expect(body.result?.status).toBe("running");
    });
  });

  describe("POST /pause", () => {
    it("pauses a running loop", async () => {
      const res = await SELF.fetch("http://localhost/pause", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<LoopState>;
      expect(body.ok).toBe(true);
      expect(body.result?.status).toBe("paused");
    });
  });

  describe("POST /destroy", () => {
    it("resets project state", async () => {
      const project = `destroy-${Date.now()}`;

      const addGate = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(addGate.status).toBe(200);

      const destroy = await SELF.fetch(`http://localhost/destroy?project=${project}`, {
        method: "POST",
      });
      expect(destroy.status).toBe(200);

      const status = await SELF.fetch(`http://localhost/status?project=${project}`);
      const body = (await status.json()) as Envelope<{
        gates: { total: number };
        loop: { status: string; iteration: number };
      }>;
      expect(body.result?.gates.total).toBe(0);
      expect(body.result?.loop.status).toBe("idle");
      expect(body.result?.loop.iteration).toBe(0);
    });
  });

  describe("envelope format", () => {
    it("every response has ok, command, and next_actions", async () => {
      const endpoints = [
        ["GET", "/status"],
        ["GET", "/gates"],
      ] as const;

      for (const [method, path] of endpoints) {
        const res = await SELF.fetch(`http://localhost${path}`, { method });
        const body = (await res.json()) as Envelope;
        expect(body).toHaveProperty("ok");
        expect(body).toHaveProperty("command");
        expect(typeof body.command).toBe("string");
        expect(body).toHaveProperty("next_actions");
        expect(Array.isArray(body.next_actions)).toBe(true);
      }
    });
  });

  describe("multi-project routing", () => {
    it("isolates gate state by project", async () => {
      const projectA = `proj-a-${Date.now()}`;
      const projectB = `proj-b-${Date.now()}`;
      const assertion = `GET /api/isolation-${Date.now()} returns 200`;

      await SELF.fetch(`http://localhost/gates?project=${projectA}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion }),
      });

      const aRes = await SELF.fetch(`http://localhost/gates?project=${projectA}`);
      const aBody = (await aRes.json()) as Envelope<{ gates: Gate[] }>;
      expect(aBody.result?.gates.some(g => g.assertion === assertion)).toBe(true);

      const bRes = await SELF.fetch(`http://localhost/gates?project=${projectB}`);
      const bBody = (await bRes.json()) as Envelope<{ gates: Gate[] }>;
      expect(bBody.result?.gates.some(g => g.assertion === assertion)).toBe(false);
    });
  });

  describe("demo runner and proof endpoints", () => {
    it("bootstraps demo gates and produces runs, slo, and proof", async () => {
      const project = `demo-${Date.now()}`;

      const bootstrap = await SELF.fetch(`http://localhost/demo/bootstrap?project=${project}`, {
        method: "POST",
      });
      expect(bootstrap.status).toBe(200);

      const run = await SELF.fetch(`http://localhost/run?project=${project}`, {
        method: "POST",
      });
      expect(run.status).toBe(200);

      const runs = await SELF.fetch(`http://localhost/runs?project=${project}`);
      const runsBody = (await runs.json()) as Envelope<{ runs: Array<{ pass: boolean }> }>;
      expect(runsBody.ok).toBe(true);
      expect((runsBody.result?.runs.length ?? 0) > 0).toBe(true);

      const slo = await SELF.fetch(`http://localhost/slo?project=${project}`);
      const sloBody = (await slo.json()) as Envelope<{ slo: { totalRuns: number } }>;
      expect(sloBody.result?.slo.totalRuns).toBeGreaterThan(0);

      const proof = await SELF.fetch(`http://localhost/proof?project=${project}`);
      const proofBody = (await proof.json()) as Envelope<{
        gates: Gate[];
        recentRuns: Array<{ pass: boolean }>;
      }>;
      expect(proofBody.ok).toBe(true);
      expect((proofBody.result?.gates.length ?? 0) > 0).toBe(true);
      expect((proofBody.result?.recentRuns.length ?? 0) > 0).toBe(true);
    });

    it("applies deterministic self-build fix and turns off demo failure mode", async () => {
      const project = `self-build-${Date.now()}`;

      const addGate = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(addGate.status).toBe(200);

      const breakDemo = await SELF.fetch(`http://localhost/demo/failure?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(breakDemo.status).toBe(200);

      const run = await SELF.fetch(`http://localhost/run?project=${project}`, {
        method: "POST",
      });
      expect(run.status).toBe(200);
      const runBody = (await run.json()) as Envelope<{
        selfBuild: { applied: boolean; action?: string };
      }>;
      expect(runBody.result?.selfBuild.applied).toBe(true);

      const config = await SELF.fetch(`http://localhost/config?project=${project}`);
      const configBody = (await config.json()) as Envelope<{ config: { demoFailureMode: boolean } }>;
      expect(configBody.result?.config.demoFailureMode).toBe(false);
    });

    it("publishes URL when all gates are green", async () => {
      const project = `publish-${Date.now()}`;
      const fn = `
export default async () => {
  const res = await fetch("data:application/json,%7B%22ok%22%3Atrue%7D");
  if (res.status !== 200) throw new Error("bad");
}
      `.trim();

      const add = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "publish-fn", fn }),
      });
      expect(add.status).toBe(200);

      const run = await SELF.fetch(`http://localhost/run?project=${project}`, { method: "POST" });
      expect(run.status).toBe(200);
      const runBody = (await run.json()) as Envelope<{ published?: string }>;
      expect(runBody.result?.published).toBeTruthy();

      const status = await SELF.fetch(`http://localhost/status?project=${project}`);
      const statusBody = (await status.json()) as Envelope<{ published?: string }>;
      expect(statusBody.result?.published).toBeTruthy();

      const proof = await SELF.fetch(`http://localhost/proof?project=${project}`);
      const proofBody = (await proof.json()) as Envelope<{ published?: string }>;
      expect(proofBody.result?.published).toBeTruthy();
    });

    it("resets gate iterations after a successful run", async () => {
      const project = `iterations-${Date.now()}`;

      await SELF.fetch(`http://localhost/config?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "maxIterations", value: 3 }),
      });

      await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });

      await SELF.fetch(`http://localhost/config?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "targetEndpoint", value: "http://127.0.0.1:9999" }),
      });
      await SELF.fetch(`http://localhost/run?project=${project}`, { method: "POST" });

      await SELF.fetch(`http://localhost/config?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "targetEndpoint", value: "http://localhost" }),
      });
      await SELF.fetch(`http://localhost/run?project=${project}`, { method: "POST" });

      const afterPass = await SELF.fetch(`http://localhost/gates?project=${project}`);
      const afterPassBody = (await afterPass.json()) as Envelope<{ gates: Gate[] }>;
      const gateAfterPass = afterPassBody.result?.gates[0];
      expect(gateAfterPass?.status).toBe("green");
      expect(gateAfterPass?.iterations).toBe(0);

      await SELF.fetch(`http://localhost/config?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "targetEndpoint", value: "http://127.0.0.1:9999" }),
      });
      await SELF.fetch(`http://localhost/run?project=${project}`, { method: "POST" });

      const afterFail = await SELF.fetch(`http://localhost/gates?project=${project}`);
      const afterFailBody = (await afterFail.json()) as Envelope<{ gates: Gate[] }>;
      const gateAfterFail = afterFailBody.result?.gates[0];
      expect(gateAfterFail?.status).toBe("red");
      expect(gateAfterFail?.iterations).toBe(1);
    });
  });

  describe("api key auth", () => {
    it("enforces x-api-key after bootstrap", async () => {
      const project = `auth-${Date.now()}`;
      const apiKey = "test-key-123";

      const bootstrap = await SELF.fetch(`http://localhost/auth/bootstrap?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      expect(bootstrap.status).toBe(200);

      const noKey = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(noKey.status).toBe(401);

      const withKey = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(withKey.status).toBe(200);
    });

    it("supports token lifecycle create/list/revoke", async () => {
      const project = `auth-token-${Date.now()}`;
      const bootstrap = await SELF.fetch(`http://localhost/auth/bootstrap?project=${project}`, {
        method: "POST",
      });
      expect(bootstrap.status).toBe(200);
      const bootBody = (await bootstrap.json()) as Envelope<{ apiKey: string }>;
      const adminKey = bootBody.result?.apiKey ?? "";
      expect(adminKey.startsWith("glk_")).toBe(true);

      const createToken = await SELF.fetch(`http://localhost/auth/tokens?project=${project}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": adminKey,
        },
        body: JSON.stringify({ name: "ci-bot", scope: "write" }),
      });
      expect(createToken.status).toBe(200);
      const createBody = (await createToken.json()) as Envelope<{
        token: { id: number };
        apiKey: string;
      }>;
      const tokenId = createBody.result?.token.id ?? 0;
      const ciKey = createBody.result?.apiKey ?? "";
      expect(tokenId).toBeGreaterThan(0);
      expect(ciKey.startsWith("glk_")).toBe(true);

      const listTokens = await SELF.fetch(`http://localhost/auth/tokens?project=${project}`);
      expect(listTokens.status).toBe(200);
      const listBody = (await listTokens.json()) as Envelope<{
        tokens: Array<{ id: number; name: string; revoked: boolean }>;
      }>;
      expect(listBody.result?.tokens.some(t => t.id === tokenId && t.name === "ci-bot")).toBe(true);

      const revoke = await SELF.fetch(`http://localhost/auth/tokens/${tokenId}?project=${project}`, {
        method: "DELETE",
        headers: { "x-api-key": adminKey },
      });
      expect(revoke.status).toBe(200);

      const withRevoked = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ciKey,
        },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(withRevoked.status).toBe(403);
    });

    it("revokes previous primary key on rotate", async () => {
      const project = `auth-rotate-${Date.now()}`;
      const oldKey = "old-primary-key";
      const newKey = "new-primary-key";

      const bootstrap = await SELF.fetch(`http://localhost/auth/bootstrap?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: oldKey }),
      });
      expect(bootstrap.status).toBe(200);

      const rotate = await SELF.fetch(`http://localhost/auth/rotate?project=${project}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": oldKey,
        },
        body: JSON.stringify({ apiKey: newKey }),
      });
      expect(rotate.status).toBe(200);

      const oldKeyWrite = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": oldKey,
        },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(oldKeyWrite.status).toBe(403);

      const newKeyWrite = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": newKey,
        },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(newKeyWrite.status).toBe(200);
    });
  });

  describe("jwt auth config", () => {
    it("can configure jwt mode and enforce credentials", async () => {
      const project = `jwt-${Date.now()}`;
      const configure = await SELF.fetch(`http://localhost/auth/jwt?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jwksUrl: "https://example.com/.well-known/jwks.json",
          requiredScope: "greenlight:write",
        }),
      });
      expect(configure.status).toBe(200);

      const status = await SELF.fetch(`http://localhost/auth/status?project=${project}`);
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as Envelope<{
        authEnabled: boolean;
        methods: string[];
      }>;
      expect(statusBody.result?.authEnabled).toBe(true);
      expect(statusBody.result?.methods.includes("jwt")).toBe(true);

      const blockedMutation = await SELF.fetch(`http://localhost/gates?project=${project}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /demo/health returns 200" }),
      });
      expect(blockedMutation.status).toBe(401);

      const blockedBootstrap = await SELF.fetch(`http://localhost/auth/bootstrap?project=${project}`, {
        method: "POST",
      });
      expect(blockedBootstrap.status).toBe(401);
    });
  });
});
