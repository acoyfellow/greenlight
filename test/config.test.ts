import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GreenlightDO } from "../src/do.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function freshDO() {
  const id = env.GREENLIGHT_DO.idFromName(`test-${Date.now()}-${Math.random()}`);
  return env.GREENLIGHT_DO.get(id) as DurableObjectStub<GreenlightDO>;
}

describe("Config", () => {
  it("returns defaults on fresh DO", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const config = instance.getConfig();
      expect(config.model).toBe(DEFAULT_CONFIG.model);
      expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
      expect(config.loopInterval).toBe(DEFAULT_CONFIG.loopInterval);
      expect(config.autoPublish).toBe(DEFAULT_CONFIG.autoPublish);
    });
  });

  it("sets and gets a config value", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.setConfig("model", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      const config = instance.getConfig();
      expect(config.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      // Other values unchanged
      expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
    });
  });

  it("sets numeric config values", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.setConfig("maxIterations", 50);
      instance.setConfig("loopInterval", 10);
      const config = instance.getConfig();
      expect(config.maxIterations).toBe(50);
      expect(config.loopInterval).toBe(10);
    });
  });

  it("sets boolean config values", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.setConfig("autoPublish", false);
      const config = instance.getConfig();
      expect(config.autoPublish).toBe(false);
    });
  });

  it("rejects unknown config keys", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      expect(() => instance.setConfig("nonexistent" as keyof import("../src/types.js").Config, "value")).toThrow();
    });
  });
});
