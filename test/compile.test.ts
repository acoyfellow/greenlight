import { describe, it, expect } from "vitest";
import { compileGate } from "../src/compile.js";

describe("compileGate", () => {
  describe("produces valid JS", () => {
    it("returns a string that parses as an async function body", () => {
      const fn = compileGate("GET /api/health returns 200");
      expect(typeof fn).toBe("string");
      expect(fn.length).toBeGreaterThan(0);
      // Must be valid JS when wrapped in an async function
      expect(() => {
        new Function("endpoint", `return (async function(endpoint) { ${fn} })`);
      }).not.toThrow();
    });
  });

  describe("status code assertions", () => {
    it("compiles GET with status check", () => {
      const fn = compileGate("GET /api/price returns 200");
      // Must fetch the path and check status
      expect(fn).toContain("/api/price");
      expect(fn).toContain("200");
    });

    it("compiles POST with body and status check", () => {
      const fn = compileGate("POST /api/subscribe with {email: 'test@test.com'} returns 201");
      expect(fn).toContain("POST");
      expect(fn).toContain("/api/subscribe");
      expect(fn).toContain("201");
      expect(fn).toContain("email");
    });

    it("compiles DELETE with status check", () => {
      const fn = compileGate("DELETE /api/item/123 returns 204");
      expect(fn).toContain("DELETE");
      expect(fn).toContain("204");
    });
  });

  describe("body field assertions", () => {
    it("compiles type checks: number", () => {
      const fn = compileGate("GET /api/price \u2192 .price is a number");
      expect(fn).toContain("price");
      expect(fn).toContain("number");
    });

    it("compiles equality checks", () => {
      const fn = compileGate("GET /api/price \u2192 .currency equals USD");
      expect(fn).toContain("currency");
      expect(fn).toContain("USD");
    });

    it("compiles type checks: string", () => {
      const fn = compileGate("GET /api/user \u2192 .name is a string");
      expect(fn).toContain("name");
      expect(fn).toContain("string");
    });

    it("compiles type checks: boolean", () => {
      const fn = compileGate("GET /api/status \u2192 .active is a boolean");
      expect(fn).toContain("active");
      expect(fn).toContain("boolean");
    });

    it("compiles array length checks", () => {
      const fn = compileGate("GET /api/items \u2192 response is array with length > 10");
      expect(fn).toContain("Array");
      expect(fn).toContain("10");
    });
  });

  describe("header assertions", () => {
    it("compiles header existence check", () => {
      const fn = compileGate("GET /api/price \u2192 Content-Type header exists");
      expect(fn).toContain("Content-Type");
    });
  });

  describe("timing assertions", () => {
    it("compiles response time threshold", () => {
      const fn = compileGate("GET /api/price \u2192 response time < 500ms");
      expect(fn).toContain("500");
    });
  });

  describe("repeat assertions", () => {
    it("compiles multi-request with field check on second response", () => {
      const fn = compileGate("GET /api/price twice within 1s \u2192 second response .cached is true");
      expect(fn).toContain("cached");
      // Must contain at least two fetch calls
      const fetchCount = (fn.match(/fetch/g) ?? []).length;
      expect(fetchCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("error cases", () => {
    it("throws on empty string", () => {
      expect(() => compileGate("")).toThrow();
    });

    it("throws on unparseable assertion", () => {
      expect(() => compileGate("this is not a gate")).toThrow();
    });
  });
});
