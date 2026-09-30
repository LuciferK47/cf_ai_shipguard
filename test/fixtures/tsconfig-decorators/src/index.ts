import { Agent, callable } from "agents";

export class Bot extends Agent<Env> {
  @callable()
  ping() {
    return "pong";
  }
}

export default { fetch: () => new Response("ok") };
