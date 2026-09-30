import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

export class Counter extends DurableObject {
  async increment(): Promise<number> {
    const next = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", next);
    return next;
  }
}

export class HealthyFlow extends WorkflowEntrypoint {
  async run() {}
}

export default {
  async fetch(_request: Request, env: Env) {
    const out = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      prompt: "hello"
    });
    return Response.json(out);
  }
};
