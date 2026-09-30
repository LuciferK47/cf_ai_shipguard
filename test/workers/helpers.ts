import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { ShipGuardAgent } from "../../src/server/agent";
import type { AuditDetail } from "../../src/shared/types";

export type AgentStub = Awaited<ReturnType<typeof newAgent>>;

/** A fresh workspace: a new agent addressed by a new UUID, as the browser would. */
export async function newAgent() {
  const id = crypto.randomUUID();
  const agent = await getAgentByName<Env, ShipGuardAgent>(
    env.ShipGuardAgent,
    id
  );
  return Object.assign(agent, { workspaceId: id });
}

/** Run code inside the agent's Durable Object (to read or arrange its private state). */
export function inAgent<R>(
  agent: AgentStub,
  fn: (instance: ShipGuardAgent) => R | Promise<R>
): Promise<R> {
  return runInDurableObject<ShipGuardAgent, R>(
    agent as unknown as DurableObjectStub<ShipGuardAgent>,
    (instance) => fn(instance)
  );
}

export const repoUrl = (name: string, tree?: string) =>
  `https://github.com/test/${name}${tree ? `/tree/${tree}` : ""}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the audit is no longer running. */
export async function waitForAudit(
  agent: AgentStub,
  auditId: string,
  timeoutMs = 25_000
): Promise<AuditDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = (await agent.getAudit(auditId)) as AuditDetail | undefined;
    if (detail && detail.status !== "running") return detail;
    if (Date.now() > deadline)
      throw new Error(`audit ${auditId} still running after ${timeoutMs} ms`);
    await sleep(100);
  }
}

/** Start an audit and wait for it. Throws if the audit could not even be started. */
export async function runAudit(
  agent: AgentStub,
  url: string
): Promise<AuditDetail> {
  const started = await agent.startAudit(url);
  if (!started.ok)
    throw new Error(
      `could not start: ${started.error.code} ${started.error.message}`
    );
  return waitForAudit(agent, started.auditId);
}

export interface OutboundCall {
  method: string;
  url: string;
  authorization: boolean;
}

/** Every request the workflow made to (the fake) GitHub, as seen by the mock. */
export async function githubCalls(): Promise<OutboundCall[]> {
  return (await (
    await fetch("https://mock.local/__calls")
  ).json()) as OutboundCall[];
}

export async function resetGithubCalls(): Promise<void> {
  await fetch("https://mock.local/__reset");
}

export interface MockAiRequest {
  model: string;
  stream: boolean;
  target: string;
  messages: Array<{ role: string; content: string }>;
}

export async function aiRequests(): Promise<MockAiRequest[]> {
  return (await (
    env.AI as unknown as { recorded(): Promise<MockAiRequest[]> }
  ).recorded()) as MockAiRequest[];
}

export async function resetAi(): Promise<void> {
  await (env.AI as unknown as { reset(): Promise<void> }).reset();
}

/** Read the text of a streamed chat reply (AI SDK UI message stream over SSE). */
export async function readChatText(
  response: Response | undefined
): Promise<string> {
  if (!response) return "";
  const raw = await response.text();
  let out = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as {
        type?: string;
        delta?: string;
        errorText?: string;
      };
      if (chunk.type === "text-delta" && chunk.delta) out += chunk.delta;
      if (chunk.type === "error" && chunk.errorText) out += chunk.errorText;
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

/** Clear the analysis cache so one test cannot serve another test's model answer. */
export async function resetCache(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.ANALYSIS_CACHE.list({ cursor });
    await Promise.all(page.keys.map((k) => env.ANALYSIS_CACHE.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/** Put every shared test fixture back to a known state. Call from `beforeEach`. */
export async function resetAll(): Promise<void> {
  await Promise.all([resetGithubCalls(), resetAi(), resetCache()]);
}
