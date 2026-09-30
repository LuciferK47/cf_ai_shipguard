import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type {
  AuditDetail,
  AuditError,
  AuditSummary,
  FindingStatus,
  ShipGuardState,
  Target
} from "../shared/types";
import { decodeFailure } from "./audit/errors";
import { isStageProgress, type PersistAuditInput } from "./audit/types";
import { buildDigest } from "./chat/digest";
import { detectIntent } from "./chat/intent";
import {
  busyMessage,
  completedMessage,
  dispositionMessage,
  failedMessage,
  invalidUrlMessage,
  noActiveTargetMessage,
  rateLimitMessage,
  startedMessage
} from "./chat/messages";
import { buildChatSystem } from "./chat/prompt";
import { parseGithubUrl, targetKey, targetUrl } from "./github/target";
import {
  MAX_AUDITS_PER_HOUR,
  MAX_CHAT_MESSAGE_CHARS,
  MAX_PERSISTED_MESSAGES,
  MAX_RECENT_IN_STATE,
  MODEL_ID,
  STALE_AUDIT_MS
} from "./limits";
import { log } from "./log";
import type { Db, SqlRunner } from "./memory/db";
import { initSchema } from "./memory/schema";
import {
  countAuditsSince,
  createAudit,
  failAudit,
  getAuditDetail,
  getAuditSummary,
  getRunningAudits,
  getStages,
  getTarget,
  latestCompleteAudit,
  listAuditSummaries,
  loadMemoryView,
  persistReport,
  pruneAudits,
  setDisposition,
  stagesForDisplay,
  upsertStage
} from "./memory/store";

export type StartResult =
  | { ok: true; auditId: string; target: Target }
  | { ok: false; error: AuditError };

const HISTORY_MESSAGES = 6;
const CHAT_MAX_OUTPUT_TOKENS = 700;
const AUDIT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: ReadonlySet<string> = new Set([
  "accepted",
  "dismissed",
  "open"
]);

/**
 * One agent per workspace. It owns the conversation, the project memory (in its
 * own SQLite database) and the running audit; the audit itself runs as a
 * durable Cloudflare Workflow that reports back here.
 */
export class ShipGuardAgent extends AIChatAgent<Env, ShipGuardState> {
  maxPersistedMessages = MAX_PERSISTED_MESSAGES;
  /** Resume a chat turn that was interrupted by an eviction. */
  chatRecovery = true;
  initialState: ShipGuardState = { recent: [] };

  private cachedDb?: Db;

  private get db(): Db {
    return (this.cachedDb ??= {
      sql: (<T>(
        strings: TemplateStringsArray,
        ...values: Parameters<SqlRunner>[1][]
      ) => this.sql<T>(strings, ...(values as never[]))) as SqlRunner,
      transaction: (fn) => this.ctx.storage.transactionSync(fn)
    });
  }

  async onStart(): Promise<void> {
    initSchema(this.db);
    await this.reconcileStale();
    this.syncState();
  }

  // ------------------------------------------------------------------ chat

  private lastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      return m.parts
        .filter(
          (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
        )
        .map((p) => p.text)
        .join("\n");
    }
    return "";
  }

  /** A chat reply written by code, streamed through the normal chat protocol. */
  private reply(text: string): Response {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      }
    });
    return createUIMessageStreamResponse({ stream });
  }

  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const text = this.lastUserText();
    if (text.length > MAX_CHAT_MESSAGE_CHARS) {
      return this.reply(
        `That message is too long. Please keep it under ${MAX_CHAT_MESSAGE_CHARS} characters.`
      );
    }

    // Deterministic routing: only questions ever reach the model.
    const intent = detectIntent(text, this.state.activeTarget !== undefined);
    switch (intent.kind) {
      case "audit": {
        const started = await this.beginAudit(intent.url);
        return this.reply(
          started.ok
            ? startedMessage(started.target, started.auditId)
            : this.errorReply(started.error)
        );
      }
      case "reaudit": {
        const active = this.state.activeTarget;
        if (!active) return this.reply(noActiveTargetMessage());
        const started = await this.beginAudit(targetUrl(active));
        return this.reply(
          started.ok
            ? startedMessage(started.target, started.auditId)
            : this.errorReply(started.error)
        );
      }
      case "disposition": {
        const key = this.state.activeTarget
          ? targetKey(this.state.activeTarget)
          : undefined;
        const ok = key
          ? setDisposition(
              this.db,
              key,
              intent.ref,
              intent.status,
              intent.note,
              new Date().toISOString()
            )
          : false;
        this.syncState();
        return this.reply(dispositionMessage(intent.ref, intent.status, ok));
      }
      case "question":
        return this.answer(options);
    }
  }

  private errorReply(error: AuditError): string {
    if (error.code === "INVALID_URL") return invalidUrlMessage(error.message);
    if (error.code === "LIMIT_REACHED") {
      const running = getRunningAudits(this.db)[0];
      const summary = running
        ? getAuditSummary(this.db, running.id)
        : undefined;
      return summary ? busyMessage(summary) : error.message;
    }
    return failedMessage(undefined, error);
  }

  /** Answer a question with the model, grounded in stored audit memory. */
  private async answer(options?: OnChatMessageOptions): Promise<Response> {
    const key = this.state.activeTarget
      ? targetKey(this.state.activeTarget)
      : undefined;
    const digest = buildDigest(
      loadMemoryView(this.db, key),
      this.lastUserText()
    );

    const workersai = createWorkersAI({
      binding: this.env.AI,
      ...(this.env.AI_GATEWAY_ID
        ? { gateway: { id: this.env.AI_GATEWAY_ID } }
        : {})
    });
    const recent: UIMessage[] = this.messages.slice(-HISTORY_MESSAGES);
    const result = streamText({
      model: workersai(MODEL_ID),
      system: buildChatSystem(digest),
      messages: await convertToModelMessages(recent),
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      abortSignal: options?.abortSignal
    });
    return result.toUIMessageStreamResponse({
      onError: (err) => {
        log("chat.error", {
          message: err instanceof Error ? err.message : String(err)
        });
        return "Workers AI is unavailable right now. Audit results are still available in the panel, and I can answer again in a moment.";
      }
    });
  }

  // ---------------------------------------------------------------- audits

  /**
   * Validate a repository URL and start an audit. Everything that can be
   * decided without a network call is decided here, before any workflow runs.
   */
  private async beginAudit(rawUrl: string): Promise<StartResult> {
    const parsed = parseGithubUrl(rawUrl);
    if (!parsed.ok)
      return {
        ok: false,
        error: { code: "INVALID_URL", message: parsed.message }
      };
    const target = parsed.target;

    await this.reconcileStale();
    if (getRunningAudits(this.db).length > 0) {
      return {
        ok: false,
        error: {
          code: "LIMIT_REACHED",
          message: "An audit is already running in this workspace."
        }
      };
    }
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (countAuditsSince(this.db, hourAgo) >= MAX_AUDITS_PER_HOUR) {
      return {
        ok: false,
        error: {
          code: "LIMIT_REACHED",
          message: rateLimitMessage(MAX_AUDITS_PER_HOUR)
        }
      };
    }

    // The audit id is also the workflow instance id, so a duplicate start
    // cannot create a second run.
    const auditId = crypto.randomUUID();
    const now = new Date().toISOString();
    createAudit(this.db, { id: auditId, target, now });
    this.setState({ ...this.state, activeTarget: target });

    try {
      await this.runWorkflow<{ auditId: string; target: Target }>(
        "AUDIT_WORKFLOW",
        { auditId, target },
        {
          id: auditId,
          metadata: { targetKey: targetKey(target) },
          agentBinding: "ShipGuardAgent"
        }
      );
    } catch (err) {
      log("audit.start_failed", {
        auditId,
        message: err instanceof Error ? err.message : String(err)
      });
      const error: AuditError = {
        code: "WORKFLOW_FAILED",
        message: "The audit could not be started. Please try again."
      };
      failAudit(this.db, auditId, error, new Date().toISOString());
      this.syncState();
      return { ok: false, error };
    }
    log("audit.started", { auditId, repo: `${target.owner}/${target.repo}` });
    this.syncState();
    return { ok: true, auditId, target };
  }

  /** Called by the workflow when the audit has finished. Idempotent. */
  async persistAuditReport(input: PersistAuditInput): Promise<AuditSummary> {
    const now = new Date().toISOString();
    const summary = persistReport(this.db, { ...input, now });
    upsertStage(
      this.db,
      input.auditId,
      "persist",
      "done",
      `${input.findings.length} findings stored`,
      input.persistMs,
      now
    );

    for (const id of pruneAudits(this.db, targetKey(summary.target))) {
      try {
        this.deleteWorkflow(id);
      } catch {
        // The workflow record may already be gone.
      }
    }

    const detail = getAuditDetail(this.db, input.auditId);
    if (detail) {
      await this.ensureAssistantMessage(
        `audit-complete-${input.auditId}`,
        completedMessage(
          detail,
          input.aiStatus === "failed" ? undefined : detail.summary
        )
      );
    }
    this.syncState();
    return summary;
  }

  /** Called by the workflow when the audit cannot finish. Idempotent. */
  async reportFailure(auditId: string, error: AuditError): Promise<void> {
    failAudit(this.db, auditId, error, new Date().toISOString());
    const summary = getAuditSummary(this.db, auditId);
    if (summary?.status === "failed") {
      await this.ensureAssistantMessage(
        `audit-failed-${auditId}`,
        failedMessage(summary.target, summary.error ?? error)
      );
    }
    this.syncState();
  }

  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    if (!isStageProgress(progress)) return;
    upsertStage(
      this.db,
      workflowId,
      progress.stage,
      progress.status,
      progress.detail,
      progress.ms,
      new Date().toISOString()
    );
    this.syncState();
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    // If the workflow already reported a precise failure, that one wins.
    await this.reportFailure(workflowId, decodeFailure(new Error(error)));
  }

  /**
   * An audit that is still "running" long after it started may have lost its
   * workflow (for example after a crash). Compare with the workflow's own status
   * so a stale audit is never shown as running forever.
   */
  private async reconcileStale(): Promise<void> {
    const cutoff = Date.now() - STALE_AUDIT_MS;
    for (const running of getRunningAudits(this.db)) {
      if (Date.parse(running.createdAt) > cutoff) continue;
      let status: string | undefined;
      try {
        status = (await this.getWorkflowStatus("AUDIT_WORKFLOW", running.id))
          .status;
      } catch {
        status = undefined;
      }
      let failure: AuditError | undefined;
      if (status === "errored" || status === "terminated") {
        failure = {
          code: "WORKFLOW_FAILED",
          message: "The audit workflow stopped before it finished."
        };
      } else if (status === "complete") {
        failure = {
          code: "STALE",
          message: "The workflow finished, but its report was not stored."
        };
      } else if (
        status === undefined &&
        Date.now() - Date.parse(running.createdAt) > 10 * STALE_AUDIT_MS
      ) {
        failure = {
          code: "STALE",
          message:
            "This audit was interrupted and its progress could not be recovered."
        };
      }
      if (failure) await this.reportFailure(running.id, failure);
    }
  }

  // ------------------------------------------------------ chat side effects

  /** Add a message written by code to the conversation, once (keyed by id). */
  private async ensureAssistantMessage(
    id: string,
    text: string
  ): Promise<void> {
    if (this.messages.some((m) => m.id === id)) return;
    // Do not write history while a turn is streaming.
    await this.waitUntilStable({ timeout: 10_000 });
    if (this.messages.some((m) => m.id === id)) return;
    await this.persistMessages([
      ...this.messages,
      { id, role: "assistant", parts: [{ type: "text", text }] }
    ]);
  }

  // ------------------------------------------------------------------ state

  /** Rebuild the small broadcast state from stored data. */
  private syncState(): void {
    const row = getRunningAudits(this.db)[0];
    const summary = row ? getAuditSummary(this.db, row.id) : undefined;
    this.setState({
      ...this.state,
      recent: listAuditSummaries(this.db, { limit: MAX_RECENT_IN_STATE }),
      running:
        row && summary
          ? {
              auditId: row.id,
              target: summary.target,
              startedAt: row.createdAt,
              stages: stagesForDisplay(getStages(this.db, row.id), true)
            }
          : undefined
    });
  }

  // ------------------------------------------------------ client-callable API

  @callable()
  async startAudit(url: string): Promise<StartResult> {
    if (typeof url !== "string")
      return {
        ok: false,
        error: {
          code: "INVALID_URL",
          message: "Enter a GitHub repository URL."
        }
      };
    const started = await this.beginAudit(url);
    if (started.ok) {
      await this.ensureAssistantMessage(
        `audit-started-${started.auditId}`,
        startedMessage(started.target, started.auditId)
      );
    }
    return started;
  }

  @callable()
  async reaudit(): Promise<StartResult> {
    const active = this.state.activeTarget;
    if (!active)
      return {
        ok: false,
        error: { code: "INVALID_URL", message: noActiveTargetMessage() }
      };
    return this.startAudit(targetUrl(active));
  }

  @callable()
  getAudit(id: string): AuditDetail | undefined {
    if (typeof id !== "string" || !AUDIT_ID.test(id)) return undefined;
    return getAuditDetail(this.db, id);
  }

  @callable()
  setFindingStatus(ref: string, status: FindingStatus, note?: string): boolean {
    if (
      typeof ref !== "string" ||
      typeof status !== "string" ||
      !STATUSES.has(status)
    )
      return false;
    const key = this.state.activeTarget
      ? targetKey(this.state.activeTarget)
      : undefined;
    if (!key) return false;
    const ok = setDisposition(
      this.db,
      key,
      ref,
      status,
      typeof note === "string" ? note.slice(0, 300) : undefined,
      new Date().toISOString()
    );
    this.syncState();
    return ok;
  }

  /** Switch the active project to one that has been audited before. */
  @callable()
  selectTarget(key: string): boolean {
    if (typeof key !== "string") return false;
    const t = getTarget(this.db, key);
    if (!t) return false;
    const latest = latestCompleteAudit(this.db, key);
    this.setState({
      ...this.state,
      activeTarget: {
        owner: t.owner,
        repo: t.repo,
        subpath: t.subpath,
        ref: latest?.target.ref
      }
    });
    this.syncState();
    return true;
  }

  /** Re-check stored state, for example after a reconnect. */
  @callable()
  async refresh(): Promise<void> {
    await this.reconcileStale();
    this.syncState();
  }
}
