import { beforeEach, describe, expect, it } from "vitest";
import { createAudit } from "../../src/server/memory/store";
import {
  aiRequests,
  githubCalls,
  inAgent,
  newAgent,
  pushTo,
  repoUrl,
  resetAll,
  runAudit,
  setGithubDown,
  waitForAudit
} from "./helpers";

beforeEach(resetAll);

async function watching(repo = "flipflop", tree = "main") {
  const agent = await newAgent();
  const first = await runAudit(agent, repoUrl(repo, tree));
  const result = await agent.setWatch(true);
  return { agent, first, result };
}

describe("watching a project for new commits", () => {
  it("schedules one check and keeps one schedule however often it is enabled", async () => {
    const { agent, result } = await watching();
    expect(result).toEqual({ ok: true });
    await agent.setWatch(true);
    await agent.setWatch(true);
    const { schedules, state } = await inAgent(agent, (a) => ({
      schedules: a.getSchedules().filter((s) => s.callback === "watchTick"),
      state: a.state
    }));
    expect(schedules).toHaveLength(1);
    expect(state.watch).toMatchObject({
      enabled: true,
      target: { owner: "test", repo: "flipflop" }
    });
  });

  it("costs no audit and no model call when nothing changed", async () => {
    const { agent, first } = await watching();
    await resetAll();

    await inAgent(agent, (a) => a.watchTick());

    const state = await inAgent(agent, (a) => a.state);
    expect(state.watch?.lastResult).toBe("unchanged");
    expect(state.watch?.lastCheckedAt).toBeDefined();
    expect(state.recent.map((r) => r.id)).toEqual([first.id]);
    // Two API calls to read the current commit, and nothing else.
    const calls = await githubCalls();
    expect(
      calls.map((c) =>
        c.url.replace("https://api.github.com/repos/test/flipflop", "")
      )
    ).toEqual(["", "/commits/main"]);
    expect(await aiRequests()).toEqual([]);
  });

  it("starts an audit by itself when a new commit appears, and says so in the chat", async () => {
    const { agent, first } = await watching();
    await pushTo("flipflop");

    await inAgent(agent, (a) => a.watchTick());

    const state = await inAgent(agent, (a) => a.state);
    expect(state.watch?.lastResult).toBe("audit-started");
    const newest = state.recent[0];
    expect(newest.id).not.toBe(first.id);
    const done = await waitForAudit(agent, newest.id);
    expect(done.status).toBe("complete");
    expect(done.sha).not.toBe(first.sha);
    expect(done.previousAuditId).toBe(first.id);

    const messages = await inAgent(agent, (a) => a.messages);
    const note = messages.find((m) => m.id === `audit-watch-${newest.id}`);
    expect(
      note?.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
    ).toContain("new commit");
  });

  it("checks again later and stays quiet once the new commit has been audited", async () => {
    const { agent } = await watching();
    await pushTo("flipflop");
    await inAgent(agent, (a) => a.watchTick());
    const started = (await inAgent(agent, (a) => a.state)).recent[0];
    await waitForAudit(agent, started.id);

    await inAgent(agent, (a) => a.watchTick());
    const state = await inAgent(agent, (a) => a.state);
    expect(state.watch?.lastResult).toBe("unchanged");
    expect(state.recent).toHaveLength(2);
  });

  it("skips a check while an audit is already running, without touching GitHub", async () => {
    const { agent } = await watching();
    await pushTo("flipflop");
    await inAgent(agent, (a) =>
      createAudit(a["db"], {
        id: crypto.randomUUID(),
        target: { owner: "test", repo: "flipflop", subpath: "" },
        now: new Date().toISOString()
      })
    );
    await resetAll();

    await inAgent(agent, (a) => a.watchTick());

    expect((await inAgent(agent, (a) => a.state)).watch?.lastResult).toBe(
      "busy"
    );
    expect(await githubCalls()).toEqual([]);
  });

  it("stops checking when watching is turned off", async () => {
    const { agent } = await watching();
    expect(await agent.setWatch(false)).toEqual({ ok: true });
    await pushTo("flipflop");
    await resetAll();

    await inAgent(agent, (a) => a.watchTick());

    const { schedules, state } = await inAgent(agent, (a) => ({
      schedules: a.getSchedules().filter((s) => s.callback === "watchTick"),
      state: a.state
    }));
    expect(schedules).toEqual([]);
    expect(state.watch).toBeUndefined();
    expect(await githubCalls()).toEqual([]);
  });

  it("cannot watch before anything has been audited", async () => {
    const agent = await newAgent();
    const res = await agent.setWatch(true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Audit a project first/);
    expect((await inAgent(agent, (a) => a.getSchedules())).length).toBe(0);
  });

  it("rejects a non-boolean argument", async () => {
    const agent = await newAgent();
    expect((await agent.setWatch("yes" as unknown as boolean)).ok).toBe(false);
  });

  it("records a failed check instead of crashing when GitHub is unavailable, then recovers", async () => {
    const { agent, first } = await watching();
    await setGithubDown("flipflop", true);

    await inAgent(agent, (a) => a.watchTick());
    let state = await inAgent(agent, (a) => a.state);
    expect(state.watch?.lastResult).toBe("error");
    expect(state.watch?.enabled).toBe(true);
    expect(state.recent.map((r) => r.id)).toEqual([first.id]);

    await setGithubDown("flipflop", false);
    await inAgent(agent, (a) => a.watchTick());
    state = await inAgent(agent, (a) => a.state);
    expect(state.watch?.lastResult).toBe("unchanged");
  });
});
