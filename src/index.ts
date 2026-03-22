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
    const url = new URL(request.url);
    let project = url.searchParams.get("project")
      ?? request.headers.get("x-greenlight-project")
      ?? "default";

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "p" && parts[1]) {
      project = decodeURIComponent(parts[1]);
      const nextPath = "/" + parts.slice(2).join("/");
      url.pathname = nextPath === "/" ? "/" : nextPath;
    }

    const stub = env.GREENLIGHT_DO.get(env.GREENLIGHT_DO.idFromName(project));
    const forwarded = new Request(url.toString(), request);
    return stub.fetch(forwarded);
  },
};
