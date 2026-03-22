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

describe("Loop state", () => {
  it("starts idle", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const state = instance.getLoopState();
      expect(state.status).toBe("idle");
      expect(state.iteration).toBe(0);
    });
  });

  it("transitions to running on start", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/health returns 200");
      instance.startLoop();
      const state = instance.getLoopState();
      expect(state.status).toBe("running");
    });
  });

  it("cannot start without gates", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      expect(() => instance.startLoop()).toThrow();
    });
  });

  it("transitions to paused on pause", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/health returns 200");
      instance.startLoop();
      instance.pauseLoop();
      const state = instance.getLoopState();
      expect(state.status).toBe("paused");
    });
  });

  it("resumes from paused to running", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/health returns 200");
      instance.startLoop();
      instance.pauseLoop();
      instance.startLoop();
      const state = instance.getLoopState();
      expect(state.status).toBe("running");
    });
  });
});
