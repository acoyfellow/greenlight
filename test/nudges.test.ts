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

describe("Nudges", () => {
  it("adds a nudge", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const nudge = instance.addNudge("Use CoinGecko's free API");
      expect(nudge.id).toBeGreaterThan(0);
      expect(nudge.text).toBe("Use CoinGecko's free API");
      expect(nudge.consumed).toBe(false);
    });
  });

  it("consumes nudges and marks them consumed", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addNudge("Use CoinGecko");
      instance.addNudge("Cache in SQLite");

      const consumed = instance.consumeNudges();
      expect(consumed).toHaveLength(2);
      expect(consumed[0]!.text).toBe("Use CoinGecko");
      expect(consumed[1]!.text).toBe("Cache in SQLite");

      // Second consume returns empty — already consumed
      const again = instance.consumeNudges();
      expect(again).toHaveLength(0);
    });
  });

  it("only consumes unconsumed nudges", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addNudge("first");
      instance.consumeNudges();
      instance.addNudge("second");

      const consumed = instance.consumeNudges();
      expect(consumed).toHaveLength(1);
      expect(consumed[0]!.text).toBe("second");
    });
  });
});
