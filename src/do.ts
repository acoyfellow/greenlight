import { DurableObject } from "cloudflare:workers";
import type { Gate, Memory, Nudge, LoopState } from "./types.js";

export interface Env {
  GREENLIGHT_DO: DurableObjectNamespace<GreenlightDO>;
  AI: Ai;
}

/**
 * The greenlight Durable Object.
 * One DO per project. SQLite for everything.
 */
export class GreenlightDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    // TODO: create tables
  }

  async fetch(_request: Request): Promise<Response> {
    // TODO: route to handlers
    return new Response("not implemented", { status: 501 });
  }

  override async alarm(): Promise<void> {
    // TODO: run one iteration of the loop
  }

  // --- Gate CRUD ---

  addGate(_assertion: string, _fn?: string): Gate {
    throw new Error("not implemented");
  }

  removeGate(_name: string): boolean {
    throw new Error("not implemented");
  }

  listGates(): Gate[] {
    throw new Error("not implemented");
  }

  // --- Gate Execution ---

  async runGates(_endpoint: string): Promise<import("./types.js").GateResult[]> {
    throw new Error("not implemented");
  }

  // --- Memory ---

  recordMemory(_trigger: string, _learning: string, _source: Memory["source"]): Memory {
    throw new Error("not implemented");
  }

  queryMemories(_search: string, _limit?: number): Memory[] {
    throw new Error("not implemented");
  }

  // --- Nudges ---

  addNudge(_text: string): Nudge {
    throw new Error("not implemented");
  }

  consumeNudges(): Nudge[] {
    throw new Error("not implemented");
  }

  // --- Loop ---

  getLoopState(): LoopState {
    throw new Error("not implemented");
  }

  startLoop(): void {
    throw new Error("not implemented");
  }

  pauseLoop(): void {
    throw new Error("not implemented");
  }
}
