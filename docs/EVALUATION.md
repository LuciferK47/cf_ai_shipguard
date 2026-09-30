# Evaluation

This is a small evaluation. It is meant to catch regressions and to be honest about what is and is not measured, not to advertise accuracy.

## What is measured

There are two suites.

| Suite         | Command            | Needs                                           | What it measures                                                          |
| ------------- | ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| Deterministic | `npm run eval`     | nothing                                         | The rule engine and the evidence pipeline against 21 fixture repositories |
| LLM           | `npm run eval:llm` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | The real Workers AI model through the same pipeline the workflow uses     |

Results are written to `evals/results/`.

## Deterministic results

Generated 2026-09-30T13:15:12.117Z by `npm run eval`.

| Measure                                                                 | Result                            |
| ----------------------------------------------------------------------- | --------------------------------- |
| Fixture repositories                                                    | 21 (5 deliberately clean)         |
| Rules in the engine / rules exercised by at least one fixture           | 19 / 19                           |
| Seeded issues found                                                     | 20 of 20                          |
| Fixtures whose reported rule set matches the expectation exactly        | 21 of 21                          |
| Clean fixtures that produced any finding                                | 0 of 5                            |
| Evidence items whose path exists in the fetched files or file tree      | 25 of 25                          |
| Evidence items with line numbers that fall inside the file              | 24 of 24                          |
| Excerpts that match the file text (up to redaction)                     | 23 (plus 1 synthetic, see below)  |
| Planted secrets that leaked into a finding                              | 0                                 |
| Oversized repository (30,002 entries): indexing time on the dev machine | 90.9 ms, bounded outputs verified |

Per rule:

| Rule                            | Expected in |  TP |  FP |  FN | Precision | Recall |
| ------------------------------- | ----------: | --: | --: | --: | --------: | -----: |
| CF_AI_BINDING_MISSING           |           2 |   2 |   0 |   0 |      1.00 |   1.00 |
| CF_CLASS_NOT_EXPORTED           |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_COMPAT_DATE_MISSING          |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_CONFIG_NOT_FOUND             |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_CONFIG_PARSE_ERROR           |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_CONFIG_UNREADABLE            |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_DEPLOY_SCRIPT_CONFIG_MISSING |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_DO_CONFIG_MIXED              |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_DO_DELETED_BUT_BOUND         |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_DO_DUPLICATE_TAG             |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_DO_KV_STORAGE                |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_DO_NOT_DECLARED              |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_ENV_FILE_COMMITTED           |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_ENV_NOT_INHERITED            |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_MAIN_NOT_FOUND               |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_NODEJS_COMPAT_MISSING        |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_SECRET_IN_VARS               |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_SECRET_PATTERN               |           1 |   1 |   0 |   0 |      1.00 |   1.00 |
| CF_TSCONFIG_DECORATORS          |           1 |   1 |   0 |   0 |      1.00 |   1.00 |

### How to read this honestly

- **The fixtures were written together with the rules.** A perfect score here means the rules do what their author intended and have not regressed. It says nothing about accuracy on repositories nobody wrote a fixture for. There is no held-out set.
- **Rules that never fire are not "100% precise".** Precision and recall of 1.00 come from one or two fixtures per rule. Small n.
- **Evidence checks are internal consistency.** Excerpts are cut from the same text the rules parsed, so their agreement with the file is expected. The check would catch an off-by-one in line mapping; it is not an independent audit. The one synthetic excerpt (`NAME: [REDACTED]`) deliberately does not quote a secret-bearing line, so it cannot match the file.
- **The oversized-repository timing is a sanity check** on one machine, not a performance claim. Real CPU limits were measured separately (below).

## Behaviour verified by tests rather than by the scorecard

These are asserted in the unit, client and workerd test suites (610 tests at the time of writing, all passing in the run recorded in the README):

- fabricated paths and lines in model output are rejected or repaired, never stored;
- invalid JSON gets exactly one bounded repair attempt, then the audit completes with deterministic findings and a visible notice;
- an exhausted Workers AI allocation is not retried;
- the analysis cache is content-addressed and never crosses repository states;
- a config file that could not be downloaded is reported as unreadable, not as missing;
- prompt-injection text stays inside its delimited block and never reaches the report;
- audits survive a Durable Object eviction, and workspaces are isolated.

## LLM evaluation

`npm run eval:llm` replays rules, facts, prompt, one model call with bounded repair, and verification over five fixtures (three with a seeded top issue, one healthy, one with prompt-injection text). It reports, per run: whether the first answer was valid, whether a repair was needed, evidence items and how many cited a path or line that was never shown (fabrication rate _before_ verification), findings proposed versus accepted, whether the seeded issue was prioritised first, and whether an injection canary reached the report. Two hard assertions apply whatever the model does: no fabricated path survives verification, and the canary never leaks.

It costs roughly 1,000 neurons per run, so with the Free plan's 10,000 neurons per day it defaults to one run per scenario. `EVAL_RUNS=3` gives more samples for a paid account.

**Status:** LLM_STATUS_PLACEHOLDER

## Measured resource limits

Cloudflare Workflows on the Free plan allow 10 ms of CPU per step and 50 subrequests per instance. These were measured on the development machine (Node, warmed) and drove the design; production workerd numbers may differ.

| Work                                          | Before      | After                                                                                       |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Static scan of a 360 KB repository (one step) | about 57 ms | scanned in batches of at most 60 KB per step (12.6 ms for all 360 KB, about 4 ms per batch) |
| Classifying a 5,800-entry file tree           | 29 ms       | 11.6 ms, in its own step, with the tree capped at about 4,000 files                         |
| Rule engine on 360 KB of source               | 25 ms       | 0.2 ms (scanning moved out of the rules)                                                    |

The planned subrequest budget is at most 39 (3 GitHub API calls, 16 file fetches, up to 6 retries, 2 model calls, 2 KV calls, about 10 agent RPC calls), plus one per sub-directory level.
