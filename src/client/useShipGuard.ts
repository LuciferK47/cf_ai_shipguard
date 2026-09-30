import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShipGuardAgent, StartResult } from "../server/agent";
import type {
  AuditDetail,
  FindingStatus,
  ShipGuardState,
  StageState
} from "../shared/types";

export const DEMO_URL =
  "https://github.com/LuciferK47/cf_ai_shipguard/tree/demo-broken/examples/demo-worker";

const EMPTY: ShipGuardState = { recent: [] };

/**
 * Everything the UI needs from one workspace agent: the live connection, the
 * small shared state, the chat, and the detail of the audit being looked at.
 * Nothing is kept only in the browser: reconnecting restores it all from the
 * agent's durable storage.
 */
export function useShipGuard(workspaceId: string) {
  const [state, setState] = useState<ShipGuardState>(EMPTY);
  const [connected, setConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<AuditDetail | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const lastRunning = useRef<string | undefined>(undefined);

  const agent = useAgent<ShipGuardAgent, ShipGuardState>({
    agent: "ShipGuardAgent",
    name: workspaceId,
    onStateUpdate: (s) => setState(s),
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false)
  });
  const chat = useAgentChat({ agent });

  // After a (re)connect, ask the agent to reconcile any audit that lost its workflow.
  useEffect(() => {
    if (connected) void agent.call("refresh", []).catch(() => undefined);
  }, [connected, agent]);

  // Follow the running audit; otherwise the most recent one, unless the user picked one.
  const effectiveId =
    selectedId ?? state.running?.auditId ?? state.recent[0]?.id;
  const summary = state.recent.find((r) => r.id === effectiveId);
  const version = summary
    ? `${summary.status}|${summary.headline}`
    : effectiveId === state.running?.auditId
      ? "running"
      : "none";

  useEffect(() => {
    if (!effectiveId || !connected) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    agent
      .call("getAudit", [effectiveId])
      .then((d) => {
        if (cancelled) return;
        setDetail((d as AuditDetail | null | undefined) ?? undefined);
        setDetailError(undefined);
      })
      .catch(() => {
        if (!cancelled)
          setDetailError("Could not load this audit. Try again in a moment.");
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId, version, connected, reload, agent]);

  // When a new audit starts, jump to it (unless the user is browsing history on purpose).
  useEffect(() => {
    const id = state.running?.auditId;
    if (id && id !== lastRunning.current) setSelectedId(undefined);
    lastRunning.current = id;
  }, [state.running?.auditId]);

  const startAudit = useCallback(
    async (url: string): Promise<StartResult> => {
      try {
        const res = (await agent.call("startAudit", [url])) as StartResult;
        if (res.ok) setSelectedId(undefined);
        return res;
      } catch {
        return {
          ok: false,
          error: {
            code: "WORKFLOW_FAILED",
            message:
              "Could not reach the agent. Check your connection and try again."
          }
        };
      }
    },
    [agent]
  );

  const reaudit = useCallback(async (): Promise<StartResult> => {
    try {
      return (await agent.call("reaudit", [])) as StartResult;
    } catch {
      return {
        ok: false,
        error: {
          code: "WORKFLOW_FAILED",
          message: "Could not reach the agent."
        }
      };
    }
  }, [agent]);

  const setFindingStatus = useCallback(
    async (ref: string, status: FindingStatus, note?: string) => {
      await agent.call("setFindingStatus", [ref, status, note]);
      setReload((n) => n + 1);
    },
    [agent]
  );

  const stages: StageState[] | undefined = useMemo(() => {
    if (state.running && state.running.auditId === effectiveId)
      return state.running.stages;
    return detail?.stages;
  }, [state.running, effectiveId, detail?.stages]);

  return {
    agent,
    chat,
    state,
    connected,
    effectiveId,
    setSelectedId,
    detail,
    detailError,
    stages,
    running:
      state.running !== undefined && state.running.auditId === effectiveId,
    startAudit,
    reaudit,
    setFindingStatus
  };
}

export type ShipGuardApi = ReturnType<typeof useShipGuard>;
