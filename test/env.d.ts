import type { Env } from "../src/do.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
