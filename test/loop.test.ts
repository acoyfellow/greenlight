import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { GreenlightDO } from "../src/do.js";

function freshDO() {
  const id = env.GREENLIGHT_DO.idFromName(`test-${Date.now()}-${Math.random()}`);
  return env.GREENLIGHT_DO.get(id) as DurableObjectStub<GreenlightDO>;
}

describe("Loop state machine", () => {
  it("starts idle with iteration 0", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const state = instance.getLoopState();
      expect(state.status).toBe("idle");
      expect(state.iteration).toBe(0);
      expect(state.lastRunAt).toBeUndefined();
    });
  });

  it("idle → running when gates exist", async () => {
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

  it("running → paused", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/health returns 200");
      instance.startLoop();
      instance.pauseLoop();
      const state = instance.getLoopState();
      expect(state.status).toBe("paused");
    });
  });

  it("paused → running", async () => {
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

  it("cannot pause when idle", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      expect(() => instance.pauseLoop()).toThrow();
    });
  });

  it("tracks iteration count", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/health returns 200");
      instance.startLoop();
      // Simulate an iteration completing by calling alarm
      await instance.alarm();
      const state = instance.getLoopState();
      expect(state.iteration).toBeGreaterThanOrEqual(1);
      expect(state.lastRunAt).toBeTruthy();
    });
  });
});
