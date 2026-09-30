# Research log

Research date: **2026-09-30**. Sources are first-party Cloudflare docs and repositories unless noted.
Where the docs and the installed packages disagreed, the installed type declarations in `node_modules` were treated as the source of truth.

Installed versions at time of research: `agents` 0.17.4, `@cloudflare/ai-chat` 0.9.4, `ai` 6.0.297, `workers-ai-provider` 3.3.1, `zod` 4.6.5, `wrangler` 4.144.0, `vitest` 4.1.11, `@cloudflare/vitest-plugin` 1.3.3, `vite` 8.3.1, `typescript` 6.0.3.

## 1. Sources consulted

| Topic                 | Page                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Assignment            | Cloudflare Software Engineer Intern posting (Greenhouse job board)                                                                         |
| Agents index          | https://developers.cloudflare.com/agents/llms.txt                                                                                          |
| AIChatAgent           | https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/                                                          |
| Agents + Workflows    | https://developers.cloudflare.com/agents/runtime/execution/run-workflows/ and https://developers.cloudflare.com/agents/concepts/workflows/ |
| State                 | https://developers.cloudflare.com/agents/runtime/lifecycle/state/                                                                          |
| Sessions              | https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/                                                                       |
| Routing               | https://developers.cloudflare.com/agents/runtime/communication/routing/                                                                    |
| Think / ThinkWorkflow | https://developers.cloudflare.com/agents/harnesses/think/workflows/                                                                        |
| Tracing               | https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/                                                         |
| Testing agents        | https://developers.cloudflare.com/agents/getting-started/testing-your-agent/                                                               |
| Vitest test APIs      | https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/                                                            |
| Workers AI model page | https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/                                                       |
| JSON mode             | https://developers.cloudflare.com/workers-ai/features/json-mode/                                                                           |
| Workers AI pricing    | https://developers.cloudflare.com/workers-ai/platform/pricing/                                                                             |
| Workflows limits      | https://developers.cloudflare.com/workflows/reference/limits/                                                                              |
| Rules of Workflows    | https://developers.cloudflare.com/workflows/build/rules-of-workflows/                                                                      |
| Wrangler config       | https://developers.cloudflare.com/workers/wrangler/configuration/                                                                          |
| Node.js compat        | https://developers.cloudflare.com/workers/runtime-apis/nodejs/                                                                             |
| Static asset headers  | https://developers.cloudflare.com/workers/static-assets/headers/                                                                           |
| Sandbox               | https://developers.cloudflare.com/agents/tools/sandbox/                                                                                    |
| Official starter      | https://github.com/cloudflare/agents-starter                                                                                               |
| Official skills       | https://github.com/cloudflare/skills (agents-sdk skill, Workflows references)                                                              |
| GitHub REST           | rate limits and Git Trees API pages on docs.github.com                                                                                     |

The Cloudflare Claude Code plugin (`/plugin marketplace add cloudflare/skills`) is installed with interactive commands, which the coding agent could not run in this environment.
The skill files were read directly from the repository instead.

## 2. Conclusions that shaped the design

**Agents SDK and chat.**
`AIChatAgent` (`@cloudflare/ai-chat`) persists chat messages to SQLite, streams over WebSocket, buffers chunks so a reconnecting client resumes the stream, and supports server tools, client tools and `needsApproval`.
The React side is `useAgent` (`agents/react`) plus `useAgentChat` (`@cloudflare/ai-chat/react`).
Every agent class needs a Durable Object binding and a `new_sqlite_classes` migration.
`experimentalDecorators` must stay off in tsconfig because it breaks `@callable`.

**Routing.**
Requests go to `/agents/{kebab-case-class-name}/{instance-name}`.
`routeAgentRequest` accepts `onBeforeConnect` and `onBeforeRequest`; returning a `Response` rejects the request.
ShipGuard uses this to reject any instance name that is not a UUID (see `docs/SECURITY.md`).

**State.**
`setState` writes SQLite and broadcasts the whole state to every connected client, so state must stay small.
The docs recommend `this.sql` tables for history and large collections.
`onStateUpdate` is deprecated in the installed 0.17.4 types in favour of `onStateChanged`.
`validateStateChange` runs before persistence and can veto an update.

**Sessions API.**
It lives under `agents/experimental/memory/session`, so it is experimental.
It is not needed for `AIChatAgent`, which has its own message persistence.
ShipGuard keeps project memory in its own SQL tables and does not depend on the experimental API.

**Workflows from an Agent.**
`AgentWorkflow` (`agents/workflows`) gives the workflow a typed `this.agent` RPC stub.

- `reportProgress()` calls `onWorkflowProgress` on the agent. It is **not durable** and can repeat on retry.
- `step.reportComplete()`, `step.reportError()` and `step.mergeAgentState()` are **durable and idempotent**.
- `runWorkflow(name, params, { id, metadata })` starts an instance and tracks it in the agent's `cf_agents_workflows` table.
- The workflow cannot open WebSockets itself; it uses the agent to reach clients.
- `pause`, `resume`, `terminate` and `restart` do not work in `wrangler dev`.

**Workflow rules that apply directly.**
Side effects go inside `step.do`. Step names must be deterministic. Non-stream step results are capped at 1 MiB.
Only step return values survive engine hibernation.
`NonRetryableError` is used for permanent failures (the docs page consulted did not show its import path, so it is checked against the installed `cloudflare:workflows` types when used).

**Free-plan Workflows limits (the plan the user chose).**
50 subrequests per instance, 10 ms CPU per step, 1,024 steps, 100 concurrent instances, 3-day retention.
Wall-clock time per step is unlimited, so waiting on the network does not consume CPU budget.
This is why ShipGuard budgets its outbound requests (`src/server/limits.ts`) and keeps CPU-heavy work small.

**Workers AI and Llama 3.3.**
Model ID `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, 24,000-token context window, function calling supported.
Pricing is 26,668 neurons per million input tokens and 204,805 per million output tokens.
The Free allocation is 10,000 neurons per day, which is roughly 14 large audits per day.
JSON mode (`response_format: { type: "json_schema", json_schema }`) supports this model but **does not support streaming**, and can fail with "JSON Mode couldn't be met".
That fits a workflow step but not the streaming chat.

**Project Think and ThinkWorkflow: rejected.**
The ThinkWorkflow docs state that this exact model honors a forced `toolChoice` only on non-streaming requests.
While streaming it answers in plain text and stops, so `step.prompt()` fails with "Model ended the turn without calling the think_final_answer tool".
Cloudflare lists `@cf/moonshotai/kimi-k2.6`, `gpt-4o-mini` and `claude-haiku-4-5` as working alternatives.
Because the assignment recommends Llama 3.3, ShipGuard uses `AIChatAgent` plus `AgentWorkflow` and calls the model itself.

**Tool calling while streaming on Llama 3.3: unverified, tested in Phase 3.**
Third-party model metadata (pi.dev) marks this model as not supporting tool streaming, which is consistent with the Think warning.
The chat therefore does not depend on model-driven tools.
Retrieval of stored audits is deterministic code that runs before the model call.
An empirical test is recorded in section 4 below.

**Tracing.**
Enabled with `"observability": { "traces": { "enabled": true } }` in the Wrangler config.
It records model calls, tool runs and approvals, and shows token usage.
It is in beta and free until 2026-10-01, after which it follows Workers Observability pricing (200,000 events/day free).
`wrangler.jsonc` also enables ordinary Workers logs.

**Testing.**
`@cloudflare/vitest-plugin` (`cloudflareTest({ wrangler: { configPath } })`) provides `cloudflare:test` helpers including `runInDurableObject`, `introspectWorkflow` and `introspectWorkflowInstance` (with `mockStepResult`, `disableSleeps`, `waitForStatus`).
It requires vitest ^4.1.
The Workers AI binding has no local simulator, so tests inject a fake LLM client and never call the real binding.

**Wrangler config.**
`wrangler.jsonc` is recommended for new projects; `compatibility_date` is required.
For compatibility dates from 2026-08-04, `nodejs_compat` and `nodejs_compat_v2` are enabled by default, so a "missing nodejs_compat" rule only applies to earlier dates.
Bindings that are not inherited by environments: `define`, `vars`, `durable_objects`, `kv_namespaces`, `r2_buckets`, `ai_search_namespaces`, `ai_search`, `vectorize`, `services`, `queues`, `workflows`, `tail_consumers`, `secrets`, `secrets_store_secrets`.
`ai` is absent from that list, so it is inherited.
KV namespaces are auto-provisioned by `wrangler deploy` when the binding has no `id`.

**Durable Object lifecycle config: `exports` replaces `migrations` for new Workers.**
Found while grounding the rules, and it changes both ShipGuard's own config and the rules that audit other people's configs.
The Durable Objects docs now recommend the declarative `exports` map (`"exports": { "MyClass": { "type": "durable-object", "storage": "sqlite" } }`) for new Workers and label the `migrations` array "legacy".
`migrations` remains fully supported for existing Workers.
A Worker cannot use both: "You cannot use `migrations` and Durable Object entries in `exports` in the same Worker configuration" (Workflow entries in `exports` may sit alongside `migrations`).
Creating new key-value-backed namespaces is no longer supported for accounts without an existing one, and `exports` supports `state: "deleted" | "renamed" | "transferred"`.
The `bindings` array is still needed to reach a class through `env`.
`wrangler 4.144.0` accepts `exports` (checked in its `config-schema.json` and by running `wrangler types`, which then derives the Durable Object namespaces from it).
The official `agents-starter` and the Agents docs still show `migrations`, so ShipGuard's rules understand both flows.
ShipGuard's own config uses `exports`; whether the Vite and Vitest plugins accept it is recorded in section 4.

**Static assets.**
A `_headers` file is supported for assets, but headers are not applied to responses generated by the Worker (including `run_worker_first` routes).
ShipGuard only sends `/agents/*` and `/api/*` through the Worker (`run_worker_first`), so the SPA shell is served by the assets layer and the CSP lives in `public/_headers`. Worker-generated API responses set their own security headers.

**GitHub.**
Unauthenticated REST calls are limited to 60 per hour per IP, and Workers share egress IPs, so the deployed app uses a `GITHUB_TOKEN` secret (5,000 per hour).
`GET /git/trees/{ref}?recursive=1` returns up to 100,000 entries or 7 MB and sets `truncated: true` beyond that.
File contents are fetched from `raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}`, which is pinned to a commit and does not consume REST quota.
Rate limits surface as HTTP 403 or 429 with `x-ratelimit-remaining: 0`.

## 3. Optional services: decisions

| Service                           | Status found                                                                 | Decision                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Sandbox                           | Requires Workers Paid; runs containers on Durable Objects                    | **Rejected.** The user's plan is Free, and the core must run without paid features.                     |
| Browser tools / Browser Run       | Experimental in the agents skill                                             | **Rejected.** Off-mission for a repo audit and unstable.                                                |
| MCP                               | Stable, but adds OAuth and connection state                                  | **Rejected.** Plain read-only GitHub REST calls are simpler and more reliable.                          |
| Code Mode                         | Experimental abstraction                                                     | **Rejected.** ShipGuard has no large tool catalog.                                                      |
| Think / ThinkWorkflow             | Known incompatibility with the required model                                | **Rejected** (see above).                                                                               |
| AI Search                         | Not needed                                                                   | **Not used.**                                                                                           |
| AI Gateway                        | Supported through the `gateway` option of `env.AI.run` and `createWorkersAI` | **Optional.** Enabled only when `AI_GATEWAY_ID` is set; adds request logs, caching and cost visibility. |
| Repository mutation (PRs, issues) | Would need `needsApproval`                                                   | **Not built.** A read-only tool is more trustworthy.                                                    |

## 4. Empirical checks

Everything below was observed, not assumed.

- `npm install` with npm 10.9.7 crashes in its resolver ("Cannot read properties of null (reading 'edgesOut')") when `vitest` is added next to `vite@8`. `--legacy-peer-deps` works, so the repository commits an `.npmrc` with `legacy-peer-deps=true`. Because that disables automatic peer installation, required peers are declared explicitly: `@babel/core`, `@ai-sdk/react` and the MCP packages that `agents` imports.
- **Dependency drift.** The starter's version ranges were six weeks stale. `@cloudflare/ai-chat` 0.9.4 called a method that `agents` 0.17.4 lacked (`host._withAgentSpan is not a function`), found only by running in workerd. Upgraded to `agents` 0.24.0 and `@cloudflare/ai-chat` 0.12.0, which changed `chatRecovery` from a boolean to a config object. The AI SDK stays on v6: `workers-ai-provider` 4.0 requires v7, a separate migration.
- **Workers reject `fetch(..., { redirect: "error" })`.** ("Invalid redirect value, must be one of follow or manual".) Every GitHub request would have failed in production; Node tests using a fake `fetch` could not see it. The client now uses `redirect: "manual"` and treats any 3xx as an error, which is also safer.
- `wrangler types` and the deploy dry run accept `exports` and `observability.traces` (wrangler 4.144.0). The dry run reports a 3,069 KiB upload, 712 KiB gzipped, well under the Free plan's limit.
- A commit SHA is accepted as a tree reference by the Git Trees API, and tree entries are about 245 bytes each, which sets the tree size cap.
- **CPU budgets (Free plan, 10 ms per step)** drove several changes; see [EVALUATION.md](./EVALUATION.md).
- Passing an `AbortSignal` from the AI SDK to a binding that is an RPC service needs the `enable_abortsignal_rpc` flag. This affects only the offline stand-in, not the real binding.
- Workers AI streaming tool calls on Llama 3.3 and JSON mode with the Zod-generated schema against the live model: recorded in the section below.

### Live model checks

Observed against the deployed Worker and the live Workers AI API on 2026-09-30:

- **JSON mode with the Zod-generated schema works** with Llama 3.3: five of five analysis calls returned schema-valid output on the first attempt.
- **Streaming chat works, with one quirk.** Each streamed event carries the token twice, as `choices[0].delta.content` and as legacy `response`. `workers-ai-provider` 3.3.1 emitted both, so answers came out doubled ("HelloHello from from..."). The mock used in tests did not reproduce it. `src/server/ai/dedupe-stream.ts` now drops the legacy field, and the fix was confirmed live.
- **Streaming tool calls were not tested**, because the design does not use model-driven tools in chat (Cloudflare's own docs say this model ignores forced tool choice while streaming).
- Workers AI streamed events also include a per-event `neurons` figure in `usage`.
