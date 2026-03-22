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

describe("Gate CRUD", () => {
  it("adds a gate from a one-liner assertion", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const gate = instance.addGate("GET /api/health returns 200");
      expect(gate.name).toBe("get-api-health-returns-200");
      expect(gate.assertion).toBe("GET /api/health returns 200");
      expect(gate.status).toBe("red");
      expect(gate.iterations).toBe(0);
    });
  });

  it("adds a custom function gate", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const fn = `export default async (endpoint) => { const r = await fetch(endpoint); if (!r.ok) throw new Error("fail"); }`;
      const gate = instance.addGate("custom-check", fn);
      expect(gate.name).toBe("custom-check");
      expect(gate.fn).toBe(fn);
      expect(gate.status).toBe("red");
    });
  });

  it("lists gates in order", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/a returns 200");
      instance.addGate("GET /api/b returns 200");
      instance.addGate("GET /api/c returns 200");
      const gates = instance.listGates();
      expect(gates).toHaveLength(3);
      expect(gates[0]!.order).toBeLessThan(gates[1]!.order);
      expect(gates[1]!.order).toBeLessThan(gates[2]!.order);
    });
  });

  it("removes a gate by name", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/a returns 200");
      instance.addGate("GET /api/b returns 200");
      const removed = instance.removeGate("get-api-a-returns-200");
      expect(removed).toBe(true);
      const gates = instance.listGates();
      expect(gates).toHaveLength(1);
      expect(gates[0]!.name).toBe("get-api-b-returns-200");
    });
  });

  it("returns false when removing non-existent gate", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      const removed = instance.removeGate("nope");
      expect(removed).toBe(false);
    });
  });

  it("rejects duplicate gate names", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/a returns 200");
      expect(() => instance.addGate("GET /api/a returns 200")).toThrow();
    });
  });

  it("all new gates start red", async () => {
    const stub = freshDO();
    await runInDurableObject(stub, async (instance: GreenlightDO) => {
      instance.addGate("GET /api/a returns 200");
      instance.addGate("GET /api/b returns 200");
      const gates = instance.listGates();
      expect(gates.every((g) => g.status === "red")).toBe(true);
    });
  });
});
