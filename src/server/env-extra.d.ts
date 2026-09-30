// Optional configuration that is not a binding, so `wrangler types` does not
// generate it. Both are Worker secrets or variables and are never sent to the client.
// The generated env.d.ts declares two `Env` interfaces (global and inside the
// `Cloudflare` namespace), so both are augmented.
interface ShipGuardOptionalEnv {
  /** Fine-grained, read-only token for public repositories. Raises the GitHub rate limit. */
  GITHUB_TOKEN?: string;
  /** Route Workers AI calls through this AI Gateway for logs, caching and cost metrics. */
  AI_GATEWAY_ID?: string;
}

declare namespace Cloudflare {
  interface Env extends ShipGuardOptionalEnv {}
}

interface Env extends ShipGuardOptionalEnv {}
