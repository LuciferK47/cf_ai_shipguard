import { describe, expect, it } from "vitest";
import {
  findSecrets,
  isPlaceholderValue,
  looksLikeSecretName,
  redactSecrets,
  safeForLog
} from "../../src/server/security/redact";

// Built at run time so no token-shaped string is stored in the repository.
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GH = ["ghp", "_", "0123456789abcdefghij0123456789abcdef"].join("");
const SLACK = ["xoxb", "-", "123456789012-abcdefghijkl"].join("");
const PEM = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");

describe("findSecrets", () => {
  it.each([
    ["aws-access-key", `const k = "${AWS}";`],
    ["github-token", `token: ${GH}`],
    ["slack-token", `SLACK=${SLACK}`],
    ["private-key", PEM]
  ])("detects %s", (id, line) => {
    const hits = findSecrets(`ok\n${line}\nok`);
    expect(hits).toHaveLength(1);
    expect(hits[0].patternId).toBe(id);
    expect(hits[0].line).toBe(2);
  });

  it("never returns the secret itself", () => {
    const hits = findSecrets(`a = "${AWS}"`);
    expect(JSON.stringify(hits)).not.toContain(AWS);
    expect(hits[0].excerpt).toContain("[REDACTED]");
  });

  it("does not flag look-alikes and ordinary text", () => {
    const text = [
      "AKIA is a prefix",
      "AKIAshort",
      "ghp_tooshort",
      "const sk = 'not-a-key'",
      "The password field is required"
    ].join("\n");
    expect(findSecrets(text)).toEqual([]);
  });

  it("skips absurdly long lines instead of scanning them", () => {
    expect(findSecrets(`${"a".repeat(5000)}${AWS}`)).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence", () => {
    const out = redactSecrets(`${AWS} and ${GH}`);
    expect(out).not.toContain(AWS);
    expect(out).not.toContain(GH);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("leaves clean text alone", () => {
    expect(redactSecrets("nothing to see")).toBe("nothing to see");
  });
});

describe("secret-name and placeholder heuristics", () => {
  it.each([
    "API_TOKEN",
    "stripeSecretKey",
    "DB_PASSWORD",
    "private_key",
    "AUTH_KEY"
  ])("treats %s as secret-like", (n) =>
    expect(looksLikeSecretName(n)).toBe(true)
  );
  it.each(["LOG_LEVEL", "PUBLIC_URL", "REGION", "MODEL_NAME"])(
    "does not treat %s as secret-like",
    (n) => expect(looksLikeSecretName(n)).toBe(false)
  );
  it.each([
    "",
    "  ",
    "changeme",
    "<your-key>",
    "your-api-key",
    "${TOKEN}",
    "{{token}}",
    "xxxxx",
    "TODO"
  ])("treats %j as a placeholder", (v) =>
    expect(isPlaceholderValue(v)).toBe(true)
  );
  it("does not treat a real-looking value as a placeholder", () => {
    expect(isPlaceholderValue("s3cr3t-value-9f8e7d")).toBe(false);
  });
});

describe("safeForLog", () => {
  it("redacts and truncates", () => {
    const out = safeForLog(`${AWS} ${"x".repeat(1000)}`);
    expect(out).not.toContain(AWS);
    expect(out.length).toBeLessThanOrEqual(500);
  });
  it("serialises objects", () => {
    expect(safeForLog({ a: 1 })).toBe('{"a":1}');
  });
});
