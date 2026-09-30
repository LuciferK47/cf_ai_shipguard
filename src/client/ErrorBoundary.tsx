import { Component, type ReactNode } from "react";

interface State {
  failed: boolean;
}

/**
 * A rendering bug must never leave a blank page. The audits themselves live in
 * the workspace's durable storage, so reloading always restores them.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error("ShipGuard UI error:", error.message);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="empty"
        role="alert"
        style={{ maxWidth: 520, margin: "10vh auto" }}
      >
        <h3>Something went wrong showing this page</h3>
        <p>
          Your audits and conversation are stored safely in your workspace.
          Reloading the page restores them.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
