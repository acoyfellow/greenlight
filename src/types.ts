/** Gate status: red (failing), green (passing), stuck (exhausted iterations) */
export type GateStatus = "red" | "green" | "stuck";

/** A gate — the core primitive. An executable assertion about what should be true. */
export interface Gate {
  name: string;
  assertion: string;       // one-liner or "custom"
  fn?: string;             // custom function body (if provided)
  status: GateStatus;
  lastError?: string;
  iterations: number;      // how many times the agent has tried this gate
  order: number;           // execution order
  dependsOn?: string;      // gate name this depends on ("after previous")
  createdAt: string;
  updatedAt: string;
}

/** Result of running a single gate */
export interface GateResult {
  name: string;
  pass: boolean;
  error?: string;
  durationMs: number;
}

/** A memory — what worked, what didn't */
export interface Memory {
  id: number;
  trigger: string;         // searchable: what situation this applies to
  learning: string;        // what was learned
  source: "gate" | "failure" | "nudge";
  createdAt: string;
}

/** A nudge — ephemeral human hint */
export interface Nudge {
  id: number;
  text: string;
  consumed: boolean;
  createdAt: string;
}

/** Project configuration — stored in SQLite, not env vars */
export interface Config {
  model: string;
  maxIterations: number;
  loopInterval: number;
  autoPublish: boolean;
}

export const DEFAULT_CONFIG: Config = {
  model: "@cf/moonshotai/kimi-k2.5",
  maxIterations: 20,
  loopInterval: 30,
  autoPublish: true,
};

/** Overall loop state */
export interface LoopState {
  status: "idle" | "running" | "paused" | "done";
  iteration: number;
  lastRunAt?: string;
}

/** JSON envelope for all CLI/API responses */
export interface Envelope<T = unknown> {
  ok: boolean;
  command: string;
  result?: T;
  error?: { message: string; code: string };
  fix?: string;
  next_actions: Array<{ command: string; description: string }>;
}
