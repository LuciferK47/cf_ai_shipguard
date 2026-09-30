import { DurableObject } from "cloudflare:workers";
export class OldRoom extends DurableObject {}
export default { fetch: () => new Response("ok") };
