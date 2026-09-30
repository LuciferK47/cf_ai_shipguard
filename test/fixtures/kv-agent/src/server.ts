import { AIChatAgent } from "@cloudflare/ai-chat";

export class ChatAgent extends AIChatAgent<Env> {}

export default { fetch: () => new Response("ok") };
