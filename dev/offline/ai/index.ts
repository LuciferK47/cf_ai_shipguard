import { WorkerEntrypoint } from "cloudflare:workers";

// A stand-in for the Workers AI binding, for running ShipGuard with no
// Cloudflare login. It does NOT use a language model. It reads the prompt the
// app would have sent and answers from the deterministic facts in it, and it
// says so in every answer. Real model behaviour needs `wrangler login`.

const NOTE =
  "Offline mode: no language model is connected, so this answer is generated from the audit data alone.";

interface Message {
  role: string;
  content: string;
}
interface Inputs {
  messages?: Message[];
  stream?: boolean;
}

function content(inputs: Inputs, role: string): string {
  return inputs.messages?.find((m) => m.role === role)?.content ?? "";
}

/** "R1 [high] CF_X: Title (path:line)" lines from the analysis prompt. */
function ruleFindings(
  user: string
): Array<{ ref: string; severity: string; title: string }> {
  const out: Array<{ ref: string; severity: string; title: string }> = [];
  for (const m of user.matchAll(
    /^(R\d+) \[(\w+)\] [A-Z0-9_]+: (.+?)(?: \([^()]*\))?$/gm
  )) {
    out.push({ ref: m[1], severity: m[2], title: m[3] });
  }
  return out;
}

function sse(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ response: text })}\n\n`)
      );
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

export default class OfflineAi extends WorkerEntrypoint {
  async run(_model: string, inputs: Inputs) {
    if (inputs.stream) {
      // Chat: quote what is stored in memory rather than pretending to reason about it.
      const system = content(inputs, "system");
      // The digest starts at a line beginning "MEMORY"; the instructions above it
      // also mention the word, so anchor on the start of a line.
      const start = system.search(/^MEMORY[ (:]/m);
      const memory = (start >= 0 ? system.slice(start) : "")
        .split("\n")
        .filter((l) =>
          /^(- |DETAIL|Change since|Coverage|Active project)/.test(l)
        )
        .slice(0, 14);
      const last =
        inputs.messages?.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const body =
        memory.length > 0
          ? `Here is what ShipGuard has stored for this project:\n\n${memory.join("\n")}`
          : "There is nothing stored yet. Paste a public GitHub repository URL to audit it.";
      return sse(`_${NOTE}_\n\nYou asked: “${last.slice(0, 160)}”\n\n${body}`);
    }

    const found = ruleFindings(content(inputs, "user"));
    const order = ["critical", "high", "medium", "low", "info"];
    found.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    return {
      response: {
        summary: `${NOTE} ${found.length === 0 ? "The deterministic rules found nothing in the inspected files." : `The deterministic rules reported ${found.length} finding${found.length === 1 ? "" : "s"}.`}`,
        priorities: found
          .slice(0, 4)
          .map((f) => ({ ref: f.ref, why: `${f.severity} severity` })),
        plan: found.slice(0, 5).map((f) => `Fix: ${f.title}`),
        findings: []
      },
      usage: { prompt_tokens: 0, completion_tokens: 0 }
    };
  }
}
