import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {}
export default { fetch: () => new Response("ok") };
