import { useCallback, useEffect, useMemo, useState } from "react";
import { Chat } from "./components/Chat";
import { Header } from "./components/Header";
import { Investigation } from "./components/Investigation";
import { Sidebar } from "./components/Sidebar";
import { resolveWorkspace, workspaceHash } from "./workspace";
import { useShipGuard } from "./useShipGuard";

type View = "audits" | "chat" | "panel";

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function App() {
  // The workspace id is decided once per page load.
  const workspaceId = useMemo(
    () => resolveWorkspace(window.location.hash, safeStorage()),
    []
  );
  useEffect(() => {
    // Keep the id in the URL so reloading or bookmarking this page returns to the same workspace.
    history.replaceState(null, "", workspaceHash(workspaceId));
  }, [workspaceId]);

  const api = useShipGuard(workspaceId);
  const { state, detail, stages, running, connected } = api;
  const [view, setView] = useState<View>("chat");

  const newWorkspace = useCallback(() => {
    try {
      window.localStorage.removeItem("shipguard.workspace");
    } catch {
      // ignore
    }
    window.location.hash = "";
    window.location.reload();
  }, []);

  const anyRunning = state.running !== undefined;

  return (
    <div className="app" data-view={view}>
      <Header
        connected={connected}
        workspaceId={workspaceId}
        onNewWorkspace={newWorkspace}
      />
      <div className="shell">
        <aside className="col col-side" aria-label="Repository and history">
          <Sidebar
            state={state}
            selectedId={api.effectiveId}
            connected={connected}
            running={anyRunning}
            onSelect={(id) => {
              api.setSelectedId(id);
              setView("panel");
            }}
            onWatch={api.setWatch}
            onStart={async (url) => {
              const res = await api.startAudit(url);
              // On small screens, follow the audit that was just started.
              if (res.ok) setView("panel");
              return res;
            }}
          />
        </aside>

        <main className="col col-chat" aria-label="Conversation">
          <Chat
            api={api}
            hasAudit={state.recent.some((a) => a.status === "complete")}
          />
        </main>

        <section className="col col-panel" aria-label="Current investigation">
          <Investigation
            detail={detail}
            stages={stages}
            running={running}
            error={api.detailError}
            connected={connected}
            onStatus={(ref, status) => void api.setFindingStatus(ref, status)}
            onReaudit={() => void api.reaudit()}
            canReaudit={
              connected && !anyRunning && state.activeTarget !== undefined
            }
          />
        </section>
      </div>

      <nav className="mobile-nav" aria-label="Sections">
        {(
          [
            ["audits", "Audits"],
            ["chat", "Chat"],
            ["panel", "Report"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
