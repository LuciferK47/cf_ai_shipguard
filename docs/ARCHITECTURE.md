# Architecture

This document answers the ten design questions (A–J) and records the decisions that departed from the original proposal.
Research backing each decision is in [RESEARCH.md](./RESEARCH.md).

## A. What ShipGuard does

A developer pastes a public GitHub repository URL (optionally with `/tree/<ref>/<subpath>`) and asks for a deployment preflight.
ShipGuard runs a staged audit:

1. resolve the target to a commit SHA
2. fetch the file tree
3. select and fetch the files that matter for a Cloudflare deploy
4. run deterministic rules over `wrangler.*`, `package.json` and source
5. ask Llama 3.3 to reason across the findings and add evidence-backed findings
6. verify every AI claim against the fetched text
7. persist the report

Findings carry a severity, a rule ID or an "AI" badge, and evidence as `path:line-range` with an excerpt.
The agent remembers each audit, so the developer can ask "what migration problem did you find earlier?" or "did we fix F-003?" and get answers grounded in stored data.

## B. Why an agent and not a single LLM request

- The work exceeds one request. It has network stages, retries, and deterministic computation the model cannot do reliably.
- The user disconnects and reconnects during an audit. Something durable has to own the run.
- The value comes from memory across audits (diffing findings between commits), which needs stored state with an identity.
- The model's context window (24k tokens) cannot hold a repository, so selection and budgeting must happen in code before the model is called.

## C. Assignment requirement to component

| Requirement             | Component                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| LLM                     | Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: JSON-mode analysis inside the workflow, streaming chat in the agent |
| Workflow / coordination | Cloudflare Workflows via `AgentWorkflow` (`src/server/workflow.ts`), started and tracked by the agent                      |
| User input (chat)       | `AIChatAgent` over WebSocket, React client with `useAgent` and `useAgentChat`, plus an audit form                          |
| Memory / state          | Durable Object SQLite (audits, findings, stable finding IDs, dispositions), small synced agent state, persisted chat       |

## D. Why these Cloudflare products

- **Agents SDK (`AIChatAgent`)**: identity, WebSockets, message persistence, resumable streams and SQLite in one class.
- **Durable Objects with SQLite**: one object per workspace gives isolation and zero-latency SQL next to the chat.
- **Workflows**: checkpointed steps with retries. The audit survives a browser disconnect and a Durable Object eviction.
- **Workers AI**: the assignment's recommended path, no external API key, runs on the same account.
- **Workers KV**: caches AI analysis by `(target, commit SHA, prompt version, model)` so re-auditing the same commit costs no neurons. This matters on the Free plan (10,000 neurons per day).
- **Workers static assets**: serves the React app from the same Worker.
- **Tracing and Workers logs**: model calls, tool runs and workflow stages are inspectable.

## E. Alternatives rejected

| Alternative                        | Why not                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Project Think + ThinkWorkflow      | Documented incompatibility: Llama 3.3 ignores forced tool choice while streaming, which breaks `step.prompt()`. |
| Model-driven tools in chat         | Llama 3.3 is not reliable at streaming tool calls. Retrieval is deterministic instead.                          |
| Sessions API for project memory    | Experimental. Own SQL tables are simpler and stable.                                                            |
| Sandbox deep verification          | Requires Workers Paid and containers. Core must run on the Free plan.                                           |
| Browser Run                        | Experimental and off-mission.                                                                                   |
| MCP GitHub server                  | Extra auth and connection state for no gain over read-only REST.                                                |
| Code Mode                          | No large tool catalog to justify it.                                                                            |
| PR or issue creation               | A read-only diagnosis tool is more trustworthy than a half-working bot.                                         |
| One agent per repository           | Different users would share chat and memory. Agents are per workspace instead.                                  |
| External model (Anthropic, OpenAI) | Workers AI is recommended by the assignment and keeps the app Cloudflare-native.                                |

## F. State partitioning

One `ShipGuardAgent` Durable Object per workspace. The instance name is a random UUID held in the browser.

| Store                               | Contents                                                                  | Bound                                 |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| AIChatAgent messages (SQLite)       | conversation                                                              | `maxPersistedMessages = 200`          |
| `this.state` (broadcast to clients) | active target, running audit stage list, up to 10 recent audit summaries  | small by construction                 |
| SQL `targets`                       | repository, ref, subpath, default branch                                  | one row per target                    |
| SQL `audits`                        | status, commit SHA, AI status, error, summary, evidence manifest, timings | last 20 per target, older rows pruned |
| SQL `audit_stages`                  | measured stage results per audit                                          | one row per stage                     |
| SQL `findings`                      | fingerprint, severity, source, evidence, status versus previous audit     | tied to pruned audits                 |
| SQL `finding_ids`                   | stable display IDs (`F-001`, ...) per target and fingerprint              | permanent                             |
| SQL `dispositions`                  | accepted or dismissed, with a note                                        | per finding                           |
| Workers KV                          | cached AI analysis                                                        | 7-day TTL                             |

Large records reach the client through a callable method (`getAudit`), not through broadcast state.

## G. How the workflow survives errors and retries

- **Steps are checkpointed.** Only step return values survive; each stage returns plain JSON under 1 MiB.
- **Retries are scoped.** Network stages retry with backoff; validation and "not found" errors throw `NonRetryableError`.
- **Free-plan budget.** The workflow plans for at most 39 subrequests (3 GitHub API calls, 16 file fetches, up to 6 retries of transient fetch failures, 2 AI calls, 2 KV calls and about 10 agent RPC calls, plus one API call per sub-directory level; see `src/server/limits.ts`), so a retry cannot exhaust the 50-request cap.
- **Per-file fetch failures are data, not exceptions.** They are recorded in the manifest, so retrying the step does not double the request count.
- **Progress is honest.** `reportProgress` fires after each completed stage. It is non-durable and can repeat, so the agent handler is an idempotent upsert keyed by `(auditId, stage)`.
- **Completion is durable.** The final write goes through `this.agent` RPC inside a SQL transaction and uses upserts, so a replayed step cannot create a duplicate report.
- **Audit ID = workflow instance ID.** A duplicate start fails instead of creating a second run.
- **Bad AI output does not fail the audit.** One bounded repair attempt, then the audit completes with deterministic findings and a visible "AI analysis unavailable: reason".
- **Stale runs are reconciled.** On start or connect, an audit still marked running after two minutes is compared with the workflow's real status.

## H. What the LLM decides versus what stays deterministic

| Deterministic code                             | LLM                                                        |
| ---------------------------------------------- | ---------------------------------------------------------- |
| URL validation, SHA resolution, tree walking   | Cross-finding reasoning and prioritization                 |
| File selection, budgets, coverage manifest     | Additional findings the rules do not cover (labelled "AI") |
| Config parsing (JSONC/TOML) and all rules      | Explanations and a remediation plan                        |
| Secret detection and redaction                 | Grounded answers to follow-up chat questions               |
| Evidence verification (paths, lines, excerpts) |                                                            |
| Finding fingerprints, diffs between audits     |                                                            |
| Chat intent detection and memory retrieval     |                                                            |

The model never checks something a regex or parser can check, and it never gets a tool that does anything.

## I. Trust and security boundaries

Full detail is in [SECURITY.md](./SECURITY.md). In short:

- **Only `https://github.com/{owner}/{repo}` reaches the fetcher.** The parser uses a strict character set and builds the outbound URLs itself.
- **Repository text is untrusted data.** It is wrapped in delimiters, the system prompt says it is data, and the model has no privileged tool to abuse.
- **AI output is untrusted.** It is schema-validated, and any evidence path or line range that was not actually shown to the model is rejected.
- **Secrets stay server-side.** `GITHUB_TOKEN` is a Worker secret, `.env` and `.dev.vars` bodies are never fetched, and logs and stored excerpts are redacted.
- **Workspaces are isolated by unguessable UUIDs.** There is no user authentication, which the README states plainly.

## J. Fallbacks when a service is unavailable

| Missing or failing                                        | Behaviour                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN` not set                                    | Works with anonymous GitHub limits. Rate-limit errors are shown with the reset time. |
| GitHub 404 or private repo                                | Visible error naming the cause. No retry.                                            |
| Workers AI error, neuron limit reached, or invalid output | Audit completes with deterministic findings and a visible AI-unavailable notice.     |
| KV cache unavailable                                      | Skipped, analysis runs normally.                                                     |
| AI Gateway not configured                                 | Direct binding calls are used.                                                       |
| Tracing off or beta ends                                  | Structured logs still record each stage.                                             |

## Decisions that differ from the original proposal

1. **No model-driven tools in chat.** Retrieval and intent handling are deterministic (Llama 3.3 tool streaming is unreliable).
2. **AI analysis uses JSON mode.** It does not stream, which is fine inside a workflow step.
3. **`AgentWorkflow` instead of a bare Workflow.** It provides typed agent RPC and progress callbacks.
4. **Free-plan budget as a first-class constraint.** Fetch caps, one KV cache, and per-workspace audit limits.
5. **Agent per workspace, not per repository.**
6. **Stable finding IDs via fingerprints.** This is what makes "is F-003 still present?" answerable.
7. **A demo repository ships inside this repo** (`examples/demo-worker`) with a broken tag and a fixed `main`, so the memory demo is reproducible.
8. **Optional extras cut** to a scheduled re-audit and an optional AI Gateway toggle.

## Implementation notes added after building it

- **Steps.** `resolve-repository` → `list-files` (parse the tree) → `classify-files` → `fetch-config-files` → `fetch-source-files` → `scan-files-N` (batched) → `run-rules` → `ai-analysis` → `verify-findings` → `persist-report`. CPU-heavy work is split across steps because the Free plan allows 10 ms of CPU per step; the measurements are in [EVALUATION.md](./EVALUATION.md).
- **Progress is reported from inside each step after the work is done.** A stage is shown as running only because the previous one finished. A stage that read nothing it needed (for example zero config files) is reported as failed, not done.
- **Unreadable is not missing.** A file that was in the tree but could not be downloaded produces `CF_CONFIG_UNREADABLE`; `CF_CONFIG_NOT_FOUND` is only reported when the tree really has no config.
- **Durable Object config.** ShipGuard's own `wrangler.jsonc` uses the declarative `exports` field; the rules understand both `exports` and legacy `migrations`.
- **Watching.** A cron schedule on the agent (`schedule("0 */6 * * *", "watchTick")`) reads the current commit and starts an audit only if it differs from the latest audit.
- **Test seam.** The Workers AI binding is called as `ai.run(...)`, so the runtime tests substitute an RPC service binding for it and exercise the production code path unchanged.
