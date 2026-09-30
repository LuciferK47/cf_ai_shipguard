import { DurableObject } from "cloudflare:workers";

// Defined but never exported, so the runtime cannot find it.
class Room extends DurableObject {}

export default { fetch: () => new Response(String(typeof Room)) };
