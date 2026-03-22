// greenlight 0.0.1 — stubs only, all tests should be RED

import { GreenlightDO } from "./do.js";
import type { Env } from "./do.js";

export { GreenlightDO };
export type { Env };
export { compileGate } from "./compile.js";
export type { Gate, GateStatus, GateResult, Memory, Nudge, LoopState } from "./types.js";

// Default Worker entrypoint — routes all requests to the DO
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.GREENLIGHT_DO.get(
      env.GREENLIGHT_DO.idFromName("default")
    );
    return stub.fetch(request);
  },
};
