import { routeAgentRequest } from "agents";
import { MODEL_ID } from "./limits";

export { ShipGuardAgent } from "./agent";
export { AuditWorkflow } from "./workflow";

// A workspace is one Durable Object, addressed by an unguessable UUID that the
// browser generates and keeps. Anything else is refused before it can create a
// Durable Object, so a request cannot be aimed at (or spawn) arbitrary names.
const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_SEGMENT = "ship-guard-agent";

/** Reject anything that is not `/agents/ship-guard-agent/<uuid>[/...]`. */
export function validateAgentRequest(request: Request): Response | undefined {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "agents" ||
    parts[1]?.toLowerCase() !== AGENT_SEGMENT ||
    !parts[2] ||
    !WORKSPACE_ID.test(parts[2])
  ) {
    return new Response("Not found", { status: 404 });
  }
  return undefined;
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      // Reports which optional features are configured, never their values.
      return new Response(
        JSON.stringify({
          ok: true,
          model: MODEL_ID,
          features: {
            githubToken: Boolean(env.GITHUB_TOKEN),
            aiGateway: Boolean(env.AI_GATEWAY_ID),
            analysisCache: Boolean(env.ANALYSIS_CACHE)
          }
        }),
        { headers: JSON_HEADERS }
      );
    }

    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: validateAgentRequest,
      onBeforeRequest: validateAgentRequest
    });
    return routed ?? new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
