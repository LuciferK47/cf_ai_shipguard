import { describe, expect, it } from "vitest";
import { dedupeEvent, dedupeStream } from "../../src/server/ai/dedupe-stream";

// Event shape copied from a live Workers AI streaming response.
const live = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }], id: "c", response: text, tool_calls: [], usage: { completion_tokens: 1 } })}`;

async function run(chunks: string[]): Promise<string> {
  const enc = new TextEncoder();
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    }
  });
  return new Response(dedupeStream(src)).text();
}

describe("dedupeEvent", () => {
  it("removes the legacy field when the OpenAI-style one is present", () => {
    const out = JSON.parse(dedupeEvent(live("Hello")).slice(5));
    expect(out.response).toBeUndefined();
    expect(out.choices[0].delta.content).toBe("Hello");
    expect(out.usage).toEqual({ completion_tokens: 1 });
  });
  it("keeps legacy-only events", () => {
    const line = 'data: {"response":"Hi"}';
    expect(dedupeEvent(line)).toBe(line);
  });
  it("leaves [DONE], blanks, comments and non-JSON alone", () => {
    for (const l of [
      "data: [DONE]",
      "",
      ": ping",
      "data: not json",
      "event: x"
    ])
      expect(dedupeEvent(l)).toBe(l);
  });
});

describe("dedupeStream", () => {
  it("fixes events split across arbitrary chunk boundaries", async () => {
    const stream = `${live("Hel")}\n\n${live("lo")}\n\ndata: [DONE]\n\n`;
    const out = await run([
      stream.slice(0, 17),
      stream.slice(17, 90),
      stream.slice(90)
    ]);
    const text = out
      .split("\n")
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(5)))
      .map((e) => `${e.choices[0].delta.content}|${e.response ?? "-"}`);
    expect(text).toEqual(["Hel|-", "lo|-"]);
    expect(out).toContain("data: [DONE]");
  });
  it("flushes a final line without a trailing newline", async () => {
    expect(await run([live("x")])).not.toContain('"response"');
  });
});
