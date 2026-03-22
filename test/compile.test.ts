import { describe, it, expect } from "vitest";
import { compileGate } from "../src/compile.js";

describe("compileGate", () => {
  describe("status code assertions", () => {
    it("compiles 'GET /path returns 200'", () => {
      const fn = compileGate("GET /api/price returns 200");
      expect(fn).toContain("fetch");
      expect(fn).toContain("/api/price");
      expect(fn).toContain("200");
    });

    it("compiles 'POST /path with {body} returns 201'", () => {
      const fn = compileGate("POST /api/subscribe with {email: 'test@test.com'} returns 201");
      expect(fn).toContain("POST");
      expect(fn).toContain("/api/subscribe");
      expect(fn).toContain("201");
      expect(fn).toContain("email");
    });

    it("compiles 'DELETE /path returns 204'", () => {
      const fn = compileGate("DELETE /api/item/123 returns 204");
      expect(fn).toContain("DELETE");
      expect(fn).toContain("204");
    });
  });

  describe("body field assertions", () => {
    it("compiles '.field is a number'", () => {
      const fn = compileGate("GET /api/price \u2192 .price is a number");
      expect(fn).toContain("price");
      expect(fn).toContain("number");
    });

    it("compiles '.field equals value'", () => {
      const fn = compileGate("GET /api/price \u2192 .currency equals USD");
      expect(fn).toContain("currency");
      expect(fn).toContain("USD");
    });

    it("compiles '.field is a string'", () => {
      const fn = compileGate("GET /api/user \u2192 .name is a string");
      expect(fn).toContain("name");
      expect(fn).toContain("string");
    });

    it("compiles '.field is a boolean'", () => {
      const fn = compileGate("GET /api/status \u2192 .active is a boolean");
      expect(fn).toContain("active");
      expect(fn).toContain("boolean");
    });

    it("compiles 'response is array with length > N'", () => {
      const fn = compileGate("GET /api/items \u2192 response is array with length > 10");
      expect(fn).toContain("Array");
      expect(fn).toContain("10");
    });
  });

  describe("header assertions", () => {
    it("compiles 'header exists'", () => {
      const fn = compileGate("GET /api/price \u2192 Content-Type header exists");
      expect(fn).toContain("Content-Type");
      expect(fn).toContain("header");
    });
  });

  describe("timing assertions", () => {
    it("compiles 'response time < 500ms'", () => {
      const fn = compileGate("GET /api/price \u2192 response time < 500ms");
      expect(fn).toContain("500");
    });
  });

  describe("repeat assertions", () => {
    it("compiles 'twice within 1s \u2192 second .cached is true'", () => {
      const fn = compileGate("GET /api/price twice within 1s \u2192 second response .cached is true");
      expect(fn).toContain("fetch");
      expect(fn).toContain("cached");
      // Should contain two fetches
      const fetchCount = (fn.match(/fetch/g) ?? []).length;
      expect(fetchCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("output is executable", () => {
    it("returns a valid async function body", () => {
      const fn = compileGate("GET /api/health returns 200");
      // Should be parseable as a function
      expect(() => {
        new Function("endpoint", `return (async function(endpoint) { ${fn} })`);
      }).not.toThrow();
    });
  });
});
