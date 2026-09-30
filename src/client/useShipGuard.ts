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
  // The loaded audit remembers which id it belongs to, so a stale one is never shown.
  const [loaded, setLoaded] = useState<
    { id: string; detail?: AuditDetail } | undefined
  >();
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

  // Effects and callbacks call the agent through a ref rather than depending on
  // its identity: if the SDK ever returned a new object per render, an effect
  // that depended on it would re-run every render and cancel its own request.
  const agentRef = useRef(agent);
  useEffect(() => {
    agentRef.current = agent;
  });

  // After a (re)connect, ask the agent to reconcile any audit that lost its workflow.
  useEffect(() => {
    if (connected)
      void agentRef.current.call("refresh", []).catch(() => undefined);
  }, [connected]);

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
    if (!effectiveId || !connected) return;
    let cancelled = false;
    agentRef.current
      .call("getAudit", [effectiveId])
      .then((d) => {
        if (cancelled) return;
        setLoaded({
          id: effectiveId,
          detail: (d as AuditDetail | null | undefined) ?? undefined
        });
        setDetailError(undefined);
      })
      .catch(() => {
        if (!cancelled)
          setDetailError("Could not load this audit. Try again in a moment.");
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId, version, connected, reload]);

  // When a new audit starts, jump to it (unless the user is browsing history on purpose).
  useEffect(() => {
    const id = state.running?.auditId;
    if (id && id !== lastRunning.current) setSelectedId(undefined);
    lastRunning.current = id;
  }, [state.running?.auditId]);

  const startAudit = useCallback(async (url: string): Promise<StartResult> => {
    try {
      const res = (await agentRef.current.call("startAudit", [
        url
      ])) as StartResult;
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
  }, []);

  const reaudit = useCallback(async (): Promise<StartResult> => {
    try {
      return (await agentRef.current.call("reaudit", [])) as StartResult;
    } catch {
      return {
        ok: false,
        error: {
          code: "WORKFLOW_FAILED",
          message: "Could not reach the agent."
        }
      };
    }
  }, []);

  const setWatch = useCallback(
    async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      try {
        return (await agentRef.current.call("setWatch", [enabled])) as {
          ok: boolean;
          error?: string;
        };
      } catch {
        return { ok: false, error: "Could not reach the agent." };
      }
    },
    []
  );

  const setFindingStatus = useCallback(
    async (ref: string, status: FindingStatus, note?: string) => {
      await agentRef.current.call("setFindingStatus", [ref, status, note]);
      setReload((n) => n + 1);
    },
    []
  );

  // `loaded` is undefined until the first load, so check it explicitly:
  // `loaded?.id === effectiveId` is also true when both are undefined, which is
  // exactly the state of a brand-new, empty workspace.
  const detail =
    connected && loaded !== undefined && loaded.id === effectiveId
      ? loaded.detail
      : undefined;

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
    setFindingStatus,
    setWatch
  };
}

export type ShipGuardApi = ReturnType<typeof useShipGuard>;
