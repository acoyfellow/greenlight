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
});
