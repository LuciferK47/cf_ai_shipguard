import type { Inline } from "./markdown-parse";
import { parseBlocks } from "./markdown-parse";

function renderInline(parts: Inline[]) {
  return parts.map((p, i) => {
    switch (p.kind) {
      case "bold":
        return <strong key={i}>{p.text}</strong>;
      case "italic":
        return <em key={i}>{p.text}</em>;
      case "code":
        return (
          <code key={i} className="inline-code">
            {p.text}
          </code>
        );
      default:
        return <span key={i}>{p.text}</span>;
    }
  });
}

/** Renders chat text. Emits text nodes only (see markdown-parse.ts). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "code") {
          return (
            <pre key={i} className="code-block">
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it)}</li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it)}</li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{renderInline(b.inline)}</p>;
      })}
    </div>
  );
}
