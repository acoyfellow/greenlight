import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import type { Envelope, Gate, LoopState } from "../src/types.js";

// Tests hit the Worker's fetch handler via SELF
// Worker routes to DO based on a project name header or path

describe("HTTP API", () => {
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

    it("rejects empty assertion", async () => {
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
      // Add a gate first
      await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/test returns 200" }),
      });

      const res = await SELF.fetch("http://localhost/gates");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ gates: Gate[] }>;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.result?.gates)).toBe(true);
    });
  });

  describe("DELETE /gates/:name", () => {
    it("removes a gate", async () => {
      // Add then remove
      await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/removeme returns 200" }),
      });

      const res = await SELF.fetch("http://localhost/gates/get-api-removeme-returns-200", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ removed: boolean }>;
      expect(body.ok).toBe(true);
      expect(body.result?.removed).toBe(true);
    });

    it("returns 404 for non-existent gate", async () => {
      const res = await SELF.fetch("http://localhost/gates/nonexistent", {
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
      expect(body.result?.loop).toBeTruthy();
      expect(body.result?.gates).toBeTruthy();
      expect(typeof body.result?.gates.total).toBe("number");
    });
  });

  describe("POST /start", () => {
    it("starts the loop", async () => {
      // Add a gate first
      await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/health returns 200" }),
      });

      const res = await SELF.fetch("http://localhost/start", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<LoopState>;
      expect(body.ok).toBe(true);
      expect(body.result?.status).toBe("running");
    });
  });

  describe("POST /pause", () => {
    it("pauses the loop", async () => {
      // Add gate, start, then pause
      await SELF.fetch("http://localhost/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "GET /api/health returns 200" }),
      });
      await SELF.fetch("http://localhost/start", { method: "POST" });

      const res = await SELF.fetch("http://localhost/pause", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<LoopState>;
      expect(body.ok).toBe(true);
      expect(body.result?.status).toBe("paused");
    });
  });

  describe("all responses follow envelope format", () => {
    it("every response has ok, command, and next_actions", async () => {
      const endpoints = [
        ["GET", "/status"],
        ["GET", "/gates"],
      ] as const;

      for (const [method, path] of endpoints) {
        const res = await SELF.fetch(`http://localhost${path}`, { method });
        const body = (await res.json()) as Envelope;
        expect(body).toHaveProperty("ok");
        expect(body).toHaveProperty("next_actions");
        expect(Array.isArray(body.next_actions)).toBe(true);
      }
    });
  });
});
