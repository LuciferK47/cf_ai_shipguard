import { Agent } from "agents";

export class DeploymentAgent extends Agent<Env> {}
export class DeployAgent extends Agent<Env> {}
export class AuditLog extends Agent<Env> {}

export default {
  async fetch() {
    return new Response("ok");
  }
};
