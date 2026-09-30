import { useState } from "react";
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from "../theme";

interface Props {
  connected: boolean;
  workspaceId: string;
  onNewWorkspace: () => void;
}

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "Theme: match system",
  light: "Theme: light",
  dark: "Theme: dark"
};

export function Header({ connected, workspaceId, onNewWorkspace }: Props) {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const cycle = () => {
    const t = nextTheme(theme);
    applyTheme(t);
    setTheme(t);
  };
  return (
    <header className="topbar">
      <div className="brand">
        <svg
          width="26"
          height="26"
          viewBox="0 0 32 32"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M16 2 4 7v8c0 7.5 5 13 12 15 7-2 12-7.5 12-15V7L16 2Z"
            fill="var(--accent)"
          />
          <path
            d="m10.5 16.5 4 4 7-8"
            fill="none"
            stroke="var(--on-accent)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>
          ShipGuard <small>deployment preflight for Cloudflare Workers</small>
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <span
        role="status"
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span className="status-dot" data-on={connected} aria-hidden="true" />
        <span>{connected ? "Connected" : "Reconnecting…"}</span>
      </span>
      <button
        type="button"
        className="btn btn-small btn-quiet"
        onClick={cycle}
        aria-label={THEME_LABEL[theme]}
        title={THEME_LABEL[theme]}
      >
        {theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}
      </button>
      <details style={{ position: "relative" }}>
        <summary
          className="btn btn-small btn-quiet"
          style={{ listStyle: "none" }}
        >
          Workspace
        </summary>
        <div
          className="callout"
          style={{
            position: "absolute",
            right: 0,
            top: "110%",
            width: 300,
            zIndex: 20,
            background: "var(--surface)"
          }}
        >
          <p style={{ margin: "0 0 6px" }}>
            Your audits and chat are saved in a private workspace identified by
            this ID. Anyone with the link to this page can see it, so treat the
            URL like a password.
          </p>
          <p
            className="mono"
            style={{ margin: "0 0 8px", overflowWrap: "anywhere" }}
          >
            {workspaceId}
          </p>
          <button
            type="button"
            className="btn btn-small"
            onClick={onNewWorkspace}
          >
            Start a new, empty workspace
          </button>
        </div>
      </details>
    </header>
  );
}
