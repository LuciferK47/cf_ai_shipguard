import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { runAnalysis } from "./ai/analyze";
import { describeFacts } from "./ai/facts";
import { createWorkersAiClient } from "./ai/llm";
import { buildAnalysisPrompt, type ShownFile } from "./ai/prompts";
import type { AiAnalysis } from "./ai/schemas";
import { verifyAnalysis } from "./ai/verify";
import {
  analysisCacheKey,
  readCachedAnalysis,
  writeCachedAnalysis
} from "./audit/cache";
import { decodeFailure, encodeFailure } from "./audit/errors";
import { fetchFiles, type FetchedFile } from "./audit/fetch";
import { buildManifest } from "./audit/manifest";
import { deterministicSummary, derivePlan, mergeAndRank } from "./audit/plan";
import type { AuditParams, StageProgress } from "./audit/types";
import type { ShipGuardAgent } from "./agent";
import { runChecks } from "./checks";
import { buildContext } from "./checks/context";
import {
  mergeScans,
  planScanBatches,
  scanFiles,
  type ScanResult
} from "./checks/scan";
import { createGithubClient, GithubError } from "./github/client";
import { chooseSources } from "./ingest/plan";
import { buildInventory, type TreeInventory } from "./ingest/select";
import { MAX_TOTAL_CHARS, MODEL_ID } from "./limits";
import { log } from "./log";
import { countBySeverity } from "./memory/store";
import type { AiStatus, StageId } from "../shared/types";

// The audit, as a durable Cloudflare Workflow.
//
// Rules this file follows (https://developers.cloudflare.com/workflows/build/rules-of-workflows/):
//  - every side effect happens inside `step.do`, and step names are fixed;
//  - a step's return value is all that survives, so each step returns plain data;
//  - progress is reported from inside the step, after its work has finished, so
//    a stage only shows as done when it really is. Reports may repeat on a retry;
//    the agent ignores any report that would move a stage backwards.
//
// Free-plan budget: 50 subrequests and 10 ms of CPU per step. Network steps are
// separate from CPU steps, per-file fetch failures are recorded instead of
// thrown (a retry would repeat every request), and scanning runs in batches.

const NETWORK = {
  retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
  timeout: "1 minute"
} as const;
const ONCE = {
  retries: { limit: 0, delay: "1 second" },
  timeout: "1 minute"
} as const;
const AI_STEP = {
  retries: { limit: 0, delay: "1 second" },
  timeout: "3 minutes"
} as const;
/** Persisting is an idempotent upsert, so it is safe to retry. */
const PERSIST = {
  retries: { limit: 2, delay: "1 second" },
  timeout: "30 seconds"
} as const;

/** GitHub failures that will not improve on retry must not be retried. */
function asWorkflowError(err: unknown): Error {
  if (err instanceof GithubError) {
    const message = encodeFailure(err.code, err.message);
    return err.retryable ? new Error(message) : new NonRetryableError(message);
  }
  return err instanceof Error ? err : new Error("unexpected failure");
}

interface AiStepResult {
  status: AiStatus;
  note?: string;
  analysis?: AiAnalysis;
  shown: Record<string, ShownFile>;
  refs: Record<string, string>;
  calls: number;
  outputTokens: number;
}

export class AuditWorkflow extends AgentWorkflow<
  ShipGuardAgent,
  AuditParams,
  StageProgress
> {
  private async progress(
    stage: StageId,
    detail: string,
    startedAt: number
  ): Promise<void> {
    await this.reportProgress({
      stage,
      status: "done",
      detail,
      ms: Date.now() - startedAt
    });
  }

  async run(event: AgentWorkflowEvent<AuditParams>, step: AgentWorkflowStep) {
    const { auditId, target } = event.payload;
    const github = createGithubClient({ token: this.env.GITHUB_TOKEN });
    const began = Date.now();
    log("audit.start", {
      auditId,
      repo: `${target.owner}/${target.repo}`,
      subpath: target.subpath
    });

    try {
      // 1. Resolve the repository, the ref and the exact commit.
      const resolved = await step.do(
        "resolve-repository",
        NETWORK,
        async () => {
          const s = Date.now();
          try {
            const repo = await github.getRepo(target.owner, target.repo);
            const ref = target.ref ?? repo.defaultBranch;
            const sha = await github.getCommitSha(
              target.owner,
              target.repo,
              ref
            );
            await this.progress(
              "resolve",
              `${target.owner}/${target.repo} at ${ref} (${sha.slice(0, 7)})`,
              s
            );
            return { sha, ref, defaultBranch: repo.defaultBranch };
          } catch (err) {
            throw asWorkflowError(err);
          }
        }
      );

      // 2. List the files (only the sub-directory's subtree when one is audited).
      const inventory: TreeInventory = await step.do(
        "list-files",
        NETWORK,
        async () => {
          const s = Date.now();
          try {
            const tree = await github.getTree(
              target.owner,
              target.repo,
              resolved.sha,
              target.subpath
            );
            const inv = buildInventory(
              tree.entries,
              target.subpath,
              tree.truncated
            );
            if (inv.discovered === 0) {
              throw new NonRetryableError(
                encodeFailure(
                  "NO_FILES",
                  "No files were found at that location in the repository."
                )
              );
            }
            const where = inv.autoSelected ? `, project in ${inv.base}` : "";
            const note = inv.treeTruncated
              ? " (GitHub truncated the list)"
              : "";
            await this.progress(
              "tree",
              `${inv.discovered} files found${where}${note}`,
              s
            );
            return inv;
          } catch (err) {
            throw asWorkflowError(err);
          }
        }
      );

      // 3. Fetch the configuration files, pinned to the commit.
      const configFiles: FetchedFile[] = await step.do(
        "fetch-config-files",
        NETWORK,
        async () => {
          const s = Date.now();
          const out = await fetchFiles(
            github,
            target.owner,
            target.repo,
            resolved.sha,
            inventory.configFiles,
            MAX_TOTAL_CHARS
          );
          if (out.rateLimited) throw asWorkflowError(out.rateLimited);
          const ok = out.files.filter((f) => f.text !== undefined).length;
          await this.progress(
            "config",
            inventory.configFiles.length === 0
              ? "no configuration files found"
              : `${ok} of ${inventory.configFiles.length} configuration files fetched`,
            s
          );
          return out.files;
        }
      );

      // 4. Choose source files using the Wrangler `main` entry, then fetch them.
      const sourceFiles: FetchedFile[] = await step.do(
        "fetch-source-files",
        NETWORK,
        async () => {
          const s = Date.now();
          const texts = new Map<string, string>();
          for (const f of configFiles)
            if (f.text !== undefined) texts.set(f.path, f.text);
          const used = configFiles.reduce((n, f) => n + f.chars, 0);
          const picks = chooseSources(inventory, texts, configFiles.length);
          const out = await fetchFiles(
            github,
            target.owner,
            target.repo,
            resolved.sha,
            picks,
            MAX_TOTAL_CHARS - used
          );
          if (out.rateLimited) throw asWorkflowError(out.rateLimited);
          const ok = out.files.filter((f) => f.text !== undefined).length;
          await this.progress(
            "sources",
            `${ok} of ${inventory.sourceFileCount} source files fetched (${picks.length} selected)`,
            s
          );
          return out.files;
        }
      );

      const fetched = [...configFiles, ...sourceFiles];
      const files = new Map<string, string>();
      for (const f of fetched)
        if (f.text !== undefined) files.set(f.path, f.text);

      // 5. Deterministic analysis. Scanning is the CPU-heavy part, so it runs
      //    in bounded batches (one step each) to respect the per-step CPU cap.
      const scans: ScanResult[] = [];
      const batches = planScanBatches(files);
      for (const [i, paths] of batches.entries()) {
        scans.push(
          await step.do(`scan-files-${i + 1}`, ONCE, async () =>
            scanFiles(files, paths)
          )
        );
      }
      const scan = mergeScans(scans);

      const checks = await step.do("run-rules", ONCE, async () => {
        const s = Date.now();
        const ctx = buildContext({
          base: inventory.base,
          files,
          paths: inventory.paths,
          pathsComplete: inventory.pathsComplete,
          neverFetched: inventory.neverFetched,
          otherProjects: inventory.otherProjects,
          sourceFileCount: inventory.sourceFileCount,
          scan
        });
        const result = runChecks(ctx);
        const skipped =
          result.skipped.length > 0
            ? `, ${result.skipped.length} rule(s) errored`
            : "";
        await this.progress(
          "static",
          `${result.rulesRun.length} rules run, ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}${skipped}`,
          s
        );
        return {
          findings: result.findings,
          facts: describeFacts(ctx),
          coverage: ctx.coverage
        };
      });

      // 6. AI analysis. Failure here never fails the audit: the deterministic
      //    findings are kept and the report says the AI step was unavailable.
      const ai: AiStepResult = await step.do(
        "ai-analysis",
        AI_STEP,
        async (): Promise<AiStepResult> => {
          const s = Date.now();
          const promptFiles = fetched
            .filter(
              (f): f is FetchedFile & { text: string } => f.text !== undefined
            )
            .map((f) => ({ path: f.path, text: f.text, reason: f.reason }));
          if (promptFiles.length === 0) {
            await this.reportProgress({
              stage: "ai",
              status: "skipped",
              detail: "no files were available to analyse",
              ms: 0
            });
            return {
              status: "skipped",
              note: "no files were available to analyse",
              shown: {},
              refs: {},
              calls: 0,
              outputTokens: 0
            };
          }

          const built = buildAnalysisPrompt({
            target,
            sha: resolved.sha,
            facts: checks.facts,
            ruleFindings: checks.findings,
            files: promptFiles,
            coverage: {
              sourceFilesTotal: checks.coverage.sourcesTotal,
              sourceFilesFetched: checks.coverage.sourcesFetched,
              neverFetched: inventory.neverFetched,
              treeTruncated: inventory.treeTruncated,
              skipped: inventory.skipped,
              otherProjects: inventory.otherProjects
            }
          });

          const key = await analysisCacheKey(
            MODEL_ID,
            built.system,
            built.user
          );
          const cached = await readCachedAnalysis(this.env.ANALYSIS_CACHE, key);
          if (cached) {
            await this.progress(
              "ai",
              "identical analysis reused from cache (no model call)",
              s
            );
            return {
              status: "cached",
              analysis: cached,
              shown: built.shown,
              refs: built.refs,
              calls: 0,
              outputTokens: 0
            };
          }

          const outcome = await runAnalysis(
            createWorkersAiClient(this.env.AI, {
              gatewayId: this.env.AI_GATEWAY_ID
            }),
            built
          );
          if (outcome.status === "ok") {
            await writeCachedAnalysis(
              this.env.ANALYSIS_CACHE,
              key,
              outcome.analysis
            );
            const repaired = outcome.repaired ? ", after one repair" : "";
            await this.progress(
              "ai",
              `analysis received (${outcome.calls} call${outcome.calls === 1 ? "" : "s"}${repaired}, ${outcome.outputTokens} output tokens)`,
              s
            );
            return {
              status: "ok",
              analysis: outcome.analysis,
              shown: built.shown,
              refs: built.refs,
              calls: outcome.calls,
              outputTokens: outcome.outputTokens
            };
          }
          await this.reportProgress({
            stage: "ai",
            status: "failed",
            detail: outcome.message,
            ms: Date.now() - s
          });
          return {
            status: "failed",
            note: outcome.message,
            shown: built.shown,
            refs: built.refs,
            calls: outcome.calls,
            outputTokens: outcome.outputTokens
          };
        }
      );

      // 7. Verify every model claim against the files the model was shown.
      const verified = await step.do("verify-findings", ONCE, async () => {
        const s = Date.now();
        const v = ai.analysis
          ? verifyAnalysis({
              raw: ai.analysis,
              shown: ai.shown,
              files,
              ruleFindings: checks.findings,
              refs: ai.refs
            })
          : undefined;
        const findings = mergeAndRank(
          checks.findings,
          v?.findings ?? [],
          v?.priorities ?? []
        );
        const counts = countBySeverity(findings);
        const rejected = v ? v.stats.proposed - v.stats.accepted : 0;
        await this.progress(
          "verify",
          v
            ? `${v.stats.accepted} of ${v.stats.proposed} AI findings verified, ${rejected} rejected`
            : "no AI findings to verify (deterministic findings only)",
          s
        );
        return {
          findings,
          summary: v?.summary || deterministicSummary(findings, counts),
          plan: v && v.plan.length > 0 ? v.plan : derivePlan(findings),
          rejected
        };
      });

      // 8. Store the report. The agent's write is an idempotent upsert in one
      //    transaction, so retrying this step cannot create a duplicate report.
      const stored = await step.do("persist-report", PERSIST, async () => {
        const s = Date.now();
        const manifest = buildManifest({
          target,
          ref: resolved.ref,
          sha: resolved.sha,
          inventory,
          fetched,
          shown: ai.shown
        });
        const summary = await this.agent.persistAuditReport({
          auditId,
          sha: resolved.sha,
          ref: resolved.ref,
          defaultBranch: resolved.defaultBranch,
          findings: verified.findings,
          summary: verified.summary,
          plan: verified.plan,
          manifest,
          aiStatus: ai.status,
          aiNote: ai.note,
          rejectedAi: verified.rejected,
          persistMs: Date.now() - s
        });
        // Return plain data: an RPC result carries a disposal marker that is not
        // serialisable, and it should be released rather than left to the GC.
        const result = { headline: summary.headline, status: summary.status };
        summary[Symbol.dispose]?.();
        return result;
      });

      await step.reportComplete({ auditId, headline: stored.headline });
      log("audit.complete", {
        auditId,
        ms: Date.now() - began,
        findings: verified.findings.length,
        ai: ai.status
      });
      return { auditId, headline: stored.headline };
    } catch (err) {
      // Record a precise, user-facing failure, then end the run.
      const failure = decodeFailure(err);
      log("audit.failed", {
        auditId,
        ms: Date.now() - began,
        code: failure.code,
        cause:
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      });
      await step.do("record-failure", ONCE, async () => {
        await this.agent.reportFailure(auditId, failure);
        return { recorded: true };
      });
      throw new NonRetryableError(encodeFailure(failure.code, failure.message));
    }
  }
}
