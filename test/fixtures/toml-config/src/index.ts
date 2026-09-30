import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {}

export default {
  async fetch(_request: Request, env: Env) {
    return Response.json(
      await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        prompt: "hi"
      })
    );
  }
};
