import { WorkerEntrypoint } from "cloudflare:workers";

// A stand-in for the Workers AI binding. `env.AI.run(model, inputs, options)`
// behaves the way the tests need, chosen by the name of the audited repository
// (the analysis prompt always contains "AUDIT TARGET: owner/repo ..."):
//
//   ai-quota          -> throws the "allocation used up" error
//   ai-garbage        -> answers with text that is not JSON (every time)
//   ai-flaky          -> first answer is invalid, the repair attempt is valid
//   ai-hallucination  -> one finding cites a file that does not exist, one is real
//   ai-chat-down      -> analysis works, but chat (streaming) requests fail
//   anything else     -> a valid, grounded analysis
//
// It also records every request so tests can assert what the model was sent.

const requests = [];

function targetOf(inputs) {
  const user = inputs?.messages?.find((m) => m.role === "user")?.content ?? "";
  return /AUDIT TARGET: (\S+)/.exec(user)?.[1] ?? "";
}

function validAnalysis() {
  return {
    summary:
      "The Worker has configuration problems that should be fixed before deployment.",
    priorities: [{ ref: "R1", why: "It blocks the deployment." }],
    plan: ["Fix the first reported finding.", "Redeploy and re-run the audit."],
    findings: []
  };
}

function sse(text) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ response: text })}\n\n`)
      );
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
        )
      );
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

export default class MockAi extends WorkerEntrypoint {
  async run(model, inputs) {
    requests.push({ model, inputs });

    if (inputs?.stream) {
      // Chat requests: the model is "down" for the ai-chat-down repository.
      const system =
        inputs.messages?.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("test/ai-chat-down"))
        throw new Error("3040: capacity temporarily exceeded");
      return sse("Here is what I found in memory.");
    }

    const target = targetOf(inputs);
    const attempt = requests.filter(
      (r) => targetOf(r.inputs) === target && !r.inputs?.stream
    ).length;

    if (target.includes("ai-quota")) {
      throw new Error(
        "4006: you have used up your daily free allocation of 10,000 neurons"
      );
    }
    if (target.includes("ai-garbage"))
      return { response: "Sure! I could not produce JSON today." };
    if (target.includes("ai-flaky") && attempt === 1)
      return { response: "{ not valid" };

    const analysis = validAnalysis();
    if (target.includes("ai-hallucination")) {
      analysis.findings = [
        {
          severity: "critical",
          confidence: 1,
          category: "bindings",
          title: "Invented problem in a file that does not exist",
          explanation: "This cites a path the model was never shown.",
          recommendation: "None.",
          evidence: [
            {
              path: "src/imaginary.ts",
              lineStart: 3,
              excerpt: "export const x = 1;"
            }
          ]
        },
        {
          severity: "high",
          confidence: 0.7,
          category: "configuration",
          title: "Entry point may be unrelated to the configured name",
          explanation:
            "The Worker name and entry file should be reviewed together.",
          recommendation: "Confirm the entry point is correct.",
          evidence: [
            {
              path: "wrangler.jsonc",
              lineStart: 2,
              excerpt: "no such text on that line"
            }
          ]
        }
      ];
    }
    return {
      response: analysis,
      usage: { prompt_tokens: 1200, completion_tokens: 180 }
    };
  }

  /** Test hooks, reached over RPC. */
  async recorded() {
    return requests.map((r) => ({
      model: r.model,
      stream: Boolean(r.inputs?.stream),
      messages: r.inputs?.messages ?? [],
      target: targetOf(r.inputs)
    }));
  }

  async reset() {
    requests.length = 0;
  }
}
