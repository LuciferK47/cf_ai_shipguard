// A deliberately small Markdown subset for chat messages, safe by construction:
// the output contains only text, never HTML, links or images. Model output can
// echo untrusted repository text, and a Markdown image or link is a classic way
// to leak data or mislead, so neither is ever produced. A link is shown as its
// text followed by the plain URL.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string };

export type Block =
  | { kind: "p"; inline: Inline[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "ul"; items: Inline[][] }
  | { kind: "ol"; items: Inline[][] };

const INLINE =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|(?<![\w*])_[^_\n]+_(?![\w])|(?<![\w*])\*[^*\n]+\*(?![\w*]))/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: "text", text: text.slice(last, i) });
    const tok = m[0];
    if (tok.startsWith("**"))
      out.push({ kind: "bold", text: tok.slice(2, -2) });
    else if (tok.startsWith("`"))
      out.push({ kind: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      out.push({ kind: "text", text: link ? `${link[1]} (${link[2]})` : tok });
    } else out.push({ kind: "italic", text: tok.slice(1, -1) });
    last = i + tok.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```(\w*)\s*$/;

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text while streaming)
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line) && !BULLET.test(line);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = (ordered ? NUMBERED : BULLET).exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i])
    ) {
      para.push(lines[i].replace(/^#{1,6}\s+/, ""));
      i++;
    }
    blocks.push({ kind: "p", inline: parseInline(para.join("\n")) });
  }
  return blocks;
}
