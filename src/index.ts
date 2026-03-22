// greenlight 0.0.1 — stubs only, all tests should be RED

import { GreenlightDO } from "./do.js";

export { GreenlightDO };
export { compileGate } from "./compile.js";
export type { Gate, GateStatus, GateResult, Memory, Nudge, LoopState } from "./types.js";

// Default Worker entrypoint — routes all requests to the DO
export default {
  async fetch(request: Request, env: { GREENLIGHT_DO: DurableObjectNamespace }): Promise<Response> {
    // For now, single project — route everything to one DO
    const id = env.GREENLIGHT_DO.idFromName("default");
    const stub = env.GREENLIGHT_DO.get(id);
    return stub.fetch(request);
  },
};
