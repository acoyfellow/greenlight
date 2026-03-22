import { describe, it, expect } from "vitest";
import {
  env,
  runInDurableObject,
} from "cloudflare:test";
import type { GreenlightDO } from "../src/do.js";

function freshDO() {
  const id = env.GREENLIGHT_DO.idFromName(`test-${Date.now()}-${Math.random()}`);
  return env.GREENLIGHT_DO.get(id) as DurableObjectStub<GreenlightDO>;
}

describe("Memory", () => {
  it("records a memory", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const mem = instance.recordMemory(
        "CSV parsing",
        "Skip the header row to avoid parse errors on line 1",
        "gate"
      );
      expect(mem.id).toBeGreaterThan(0);
      expect(mem.trigger).toBe("CSV parsing");
      expect(mem.learning).toBe("Skip the header row to avoid parse errors on line 1");
      expect(mem.source).toBe("gate");
    });
  });

  it("queries memories by FTS match", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.recordMemory("CSV parsing", "Skip header row", "gate");
      instance.recordMemory("CoinGecko API", "Returns floats as strings", "failure");
      instance.recordMemory("CORS headers", "Must set Access-Control-Allow-Origin", "nudge");

      const csvResults = instance.queryMemories("CSV");
      expect(csvResults).toHaveLength(1);
      expect(csvResults[0]!.trigger).toBe("CSV parsing");

      const apiResults = instance.queryMemories("API");
      expect(apiResults).toHaveLength(1);
      expect(apiResults[0]!.trigger).toBe("CoinGecko API");
    });
  });

  it("returns empty array for no matches", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.recordMemory("CSV parsing", "Skip header row", "gate");
      const results = instance.queryMemories("blockchain");
      expect(results).toHaveLength(0);
    });
  });

  it("respects limit parameter", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      for (let i = 0; i < 10; i++) {
        instance.recordMemory(`error ${i}`, `fix ${i}`, "failure");
      }
      const results = instance.queryMemories("error", 3);
      expect(results).toHaveLength(3);
    });
  });
});
