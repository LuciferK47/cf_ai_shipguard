import { describe, expect, it } from "vitest";
import {
  findGithubUrls,
  parseGithubUrl,
  targetKey,
  targetUrl
} from "../../src/server/github/target";

function ok(input: string) {
  const r = parseGithubUrl(input);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.target;
}

describe("parseGithubUrl: accepted forms", () => {
  it("parses a plain repository URL", () => {
    expect(ok("https://github.com/cloudflare/agents-starter")).toEqual({
      owner: "cloudflare",
      repo: "agents-starter",
      subpath: ""
    });
  });

  it("accepts a trailing slash and a .git suffix", () => {
    expect(ok("https://github.com/o/r/").repo).toBe("r");
    expect(ok("https://github.com/o/r.git").repo).toBe("r");
  });

  it("parses /tree/{ref}/{subpath}", () => {
    expect(ok("https://github.com/o/r/tree/main/examples/demo")).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
      subpath: "examples/demo"
    });
  });

  it("parses /tree/{ref} without a subpath", () => {
    expect(ok("https://github.com/o/r/tree/v1.2.3").ref).toBe("v1.2.3");
  });

  it("trims surrounding whitespace", () => {
    expect(ok("  https://github.com/o/r  ").owner).toBe("o");
  });
});

describe("parseGithubUrl: rejected input (SSRF and injection boundary)", () => {
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["not a url", "hello world"],
    ["http scheme", "http://github.com/o/r"],
    ["other host", "https://gitlab.com/o/r"],
    ["look-alike host", "https://github.com.evil.com/o/r"],
    ["subdomain", "https://api.github.com/repos/o/r"],
    ["raw host", "https://raw.githubusercontent.com/o/r/main/x"],
    ["credentials", "https://user:pw@github.com/o/r"],
    ["port", "https://github.com:8443/o/r"],
    ["query string", "https://github.com/o/r?tab=readme"],
    ["localhost", "https://localhost/o/r"],
    ["ip literal", "https://127.0.0.1/o/r"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["only owner", "https://github.com/o"],
    ["percent-encoded slash", "https://github.com/o/r%2f..%2fx"],
    ["backslash", "https://github.com/o/r\\..\\x"],
    ["path traversal repo", "https://github.com/o/.."],
    ["traversal in subpath", "https://github.com/o/r/tree/main/../secret"],
    ["dot-dot ref", "https://github.com/o/r/tree/a..b/x"],
    ["unsupported route", "https://github.com/o/r/issues/1"],
    ["blob route", "https://github.com/o/r/blob/main/a.ts"],
    ["missing ref", "https://github.com/o/r/tree"],
    ["owner leading hyphen", "https://github.com/-bad/r"],
    ["owner too long", `https://github.com/${"a".repeat(40)}/r`],
    ["control char", "https://github.com/o/r\u0007"],
    ["newline injection", "https://github.com/o/r\nHost: evil"],
    ["too long", `https://github.com/o/${"r".repeat(400)}`]
  ];
  it.each(bad)("rejects %s", (_name, input) => {
    expect(parseGithubUrl(input).ok).toBe(false);
  });

  it("rejects a subpath that is too deep", () => {
    const deep = Array.from({ length: 12 }, (_, i) => `d${i}`).join("/");
    expect(parseGithubUrl(`https://github.com/o/r/tree/main/${deep}`).ok).toBe(
      false
    );
  });
});

describe("targetKey and targetUrl", () => {
  it("ignores the ref so audits of two commits are comparable", () => {
    const a = ok("https://github.com/O/R/tree/demo-broken/examples/w");
    const b = ok("https://github.com/o/r/tree/main/examples/w");
    expect(targetKey(a)).toBe(targetKey(b));
  });

  it("distinguishes sub-directories", () => {
    expect(targetKey(ok("https://github.com/o/r/tree/main/a"))).not.toBe(
      targetKey(ok("https://github.com/o/r/tree/main/b"))
    );
  });

  it("builds a canonical URL", () => {
    expect(targetUrl(ok("https://github.com/o/r"))).toBe(
      "https://github.com/o/r"
    );
    expect(targetUrl(ok("https://github.com/o/r/tree/main/x"))).toBe(
      "https://github.com/o/r/tree/main/x"
    );
  });
});

describe("findGithubUrls", () => {
  it("extracts URLs from prose and strips trailing punctuation", () => {
    const urls = findGithubUrls(
      "Audit https://github.com/o/r, then (https://github.com/a/b/tree/main)."
    );
    expect(urls).toEqual([
      "https://github.com/o/r",
      "https://github.com/a/b/tree/main"
    ]);
  });

  it("de-duplicates", () => {
    expect(
      findGithubUrls("https://github.com/o/r https://github.com/o/r")
    ).toHaveLength(1);
  });

  it("returns nothing when there is no URL", () => {
    expect(findGithubUrls("what did you find earlier?")).toEqual([]);
  });
});
