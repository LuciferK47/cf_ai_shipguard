import { Agent, routeAgentRequest } from "agents";

interface Env {
  AI: Ai;
  DEPLOY_AGENT: DurableObjectNamespace<DeploymentAgent>;
  LOG_LEVEL: string;
  WEBHOOK_SECRET: string;
}

/** A tiny agent that reviews a deployment note with Workers AI. */
export class DeploymentAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const { note } = (await request.json()) as { note?: string };
    const review = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You review deployment notes and list risks." },
        { role: "user", content: note ?? "" }
      ]
    });
    return Response.json(review);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
