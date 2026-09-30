// Workers AI's streaming output currently carries every token twice per event:
// once as `choices[0].delta.content` (OpenAI format) and once as `response`
// (legacy). workers-ai-provider reads both and emits the text twice, so chat
// answers came out as "HelloHello from from ...". Observed against the live
// service; the mock in the tests did not reproduce it.
//
// This drops the legacy `response` field from events that also carry `choices`.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function dedupeEvent(line: string): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return line;
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (Array.isArray(event.choices) && "response" in event) {
      delete event.response;
      return `data: ${JSON.stringify(event)}`;
    }
  } catch {
    // Not JSON: pass through untouched.
  }
  return line;
}

/** Transform an SSE byte stream, fixing each complete line. */
export function dedupeStream(
  input: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  let buffer = "";
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines)
          controller.enqueue(encoder.encode(`${dedupeEvent(line)}\n`));
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(dedupeEvent(buffer)));
      }
    })
  );
}

/** Wrap the Workers AI binding so streamed results are de-duplicated. Other results pass through. */
export function withDedupedStreams(ai: Ai): Ai {
  const wrapped = {
    run: async (...args: unknown[]) => {
      const target = ai as unknown as {
        run(...a: unknown[]): Promise<unknown>;
      };
      const result = await target.run(...args);
      return result instanceof ReadableStream
        ? dedupeStream(result as ReadableStream<Uint8Array>)
        : result;
    }
  };
  return new Proxy(ai, {
    get: (t, prop, receiver) =>
      prop === "run" ? wrapped.run : Reflect.get(t, prop, receiver)
  });
}
