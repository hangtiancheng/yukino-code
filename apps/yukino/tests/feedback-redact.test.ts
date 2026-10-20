import { describe, expect, it } from "vitest";

import {
  isSensitiveKey,
  redactJsonLines,
  redactJsonValue,
  redactText,
  redactUrl,
} from "@/feedback/redact.js";

type SecretKind =
  "anthropic" | "openai" | "aws" | "gcp" | "github" | "slack" | "bearer";

const ALL_KINDS: SecretKind[] = [
  "anthropic",
  "openai",
  "aws",
  "gcp",
  "github",
  "slack",
  "bearer",
];

// Fake secrets are assembled from fragments at runtime so no contiguous
// realistic token literal ever appears in source — GitHub push protection
// rejects commits that contain them (a Slack-format fixture was flagged).
function fakeSecret(kind: SecretKind): string {
  switch (kind) {
    case "anthropic":
      return ["sk", "ant", "api03", "ABCDEFGHIJKLMNOPQRST", "1234567890"].join(
        "-",
      );
    case "openai":
      return ["sk", "proj", "ABCDEFGHIJKLMNOPQRSTUVWX1234"].join("-");
    case "aws":
      return ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    case "gcp":
      return ["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("");
    case "github":
      return ["ghp", "1234567890abcdefghijklmnopqrstuvwxyzAB"].join("_");
    case "slack":
      return [
        "xoxb",
        "123456789012",
        "1234567890123",
        "AbCdEfGhIjKlMnOpQrStUvWx",
      ].join("-");
    case "bearer":
      return [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        "abc",
      ].join(".");
  }
}

describe("redactText", () => {
  it("redacts known key formats", () => {
    const input = [
      `anthropic: ${fakeSecret("anthropic")}`,
      `openai: ${fakeSecret("openai")}`,
      `aws: ${fakeSecret("aws")}`,
      `gcp: ${fakeSecret("gcp")}`,
      `github: ${fakeSecret("github")}`,
      `slack: ${fakeSecret("slack")}`,
      `header: Bearer ${fakeSecret("bearer")}`,
    ].join("\n");
    const out = redactText(input);
    for (const kind of ALL_KINDS) {
      expect(out, `${kind} secret survived redaction`).not.toContain(
        fakeSecret(kind),
      );
    }
    expect(out).toContain("Bearer <redacted>");
  });

  it("leaves git SHAs and ordinary text alone", () => {
    const sha = "8f14e45fceea167a5a36dedd4bea2543c4d1a2b3";
    const text = `commit ${sha} fixed the retry loop; see docs/page-2.md`;
    expect(redactText(text)).toBe(text);
  });

  it("preserves evidence and links when configured credentials are short placeholders", () => {
    const text =
      "yukino 0.0.17; step 1; TODO 1/4; node v24.16.0; https://gist.github.com/test/a1b2c3";
    expect(redactText(text, ["1", "on", "true"])).toBe(text);
    const out = redactText(
      'api_key: "1"\npassword=x\nhttps://user:x@example.com/?token=1',
      ["1", "x"],
    );
    expect(out).toContain('api_key: "<redacted>"');
    expect(out).toContain("password=<redacted>");
    expect(out).toContain("token=%3Credacted%3E");
    expect(out).not.toContain("user:x");
  });

  it("redacts arbitrary named credentials and embedded credential URLs", () => {
    const text =
      'api_key: opaque-key\napiKey="another-key"\nGET https://user:pass@example.com/?api_key=query-key';
    const out = redactText(text);
    for (const secret of [
      "opaque-key",
      "another-key",
      "user:pass",
      "query-key",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("example.com");
  });

  it("redacts YAML block credentials while preserving the following settings", () => {
    const out = redactText(
      "provider:\n  api_key: |\n    opaque-multiline-key\n    continuation\n  model: test-model\n",
    );
    expect(out).not.toContain("opaque-multiline-key");
    expect(out).not.toContain("continuation");
    expect(out).toContain("model: test-model");
  });
});

describe("redactUrl", () => {
  it("strips userinfo and sensitive query params", () => {
    expect(redactUrl("https://user:pass@example.com/repo")).toBe(
      "https://example.com/repo",
    );
    const out = redactUrl("https://api.example.com/v1?api_key=abc123&page=2");
    // URLSearchParams serializes the replacement, so <redacted> arrives encoded.
    expect(out).toContain("api_key=%3Credacted%3E");
    expect(out).toContain("page=2");
    expect(out).not.toContain("abc123");
  });

  it("unwraps nested scheme URLs", () => {
    const out = redactUrl("jdbc:postgresql://user:secret@db:5432/app");
    expect(out).not.toContain("secret");
    expect(out).toContain("db:5432/app");
  });

  it("passes non-URLs through", () => {
    expect(redactUrl("not a url at all")).toBe("not a url at all");
  });
});

describe("redactJsonValue", () => {
  it("redacts by key name including camelCase and nesting", () => {
    const value = {
      provider: { apiKey: "super-secret-value", model: "gpt-x" },
      headers: { Authorization: "Bearer abc" },
      list: [{ password: "hunter2", user: "bob" }],
      accessToken: "tok_12345678901234567890",
    };
    const out = JSON.stringify(redactJsonValue(value));
    expect(out).not.toContain("super-secret-value");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("tok_12345678901234567890");
    expect(out).toContain('"model":"gpt-x"');
    expect(out).toContain('"user":"bob"');
    expect(out).toContain("<redacted>");
  });

  it("pattern-redacts secrets inside ordinary string values", () => {
    const out = JSON.stringify(
      redactJsonValue({ note: `key is ${fakeSecret("anthropic")}` }),
    );
    expect(out).not.toContain(fakeSecret("anthropic"));
    expect(out).toContain("<redacted>");
  });

  it("classifies sensitive keys", () => {
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("API-KEY")).toBe(true);
    expect(isSensitiveKey("access_token")).toBe(true);
    expect(isSensitiveKey("tokenizer")).toBe(false);
    expect(isSensitiveKey("secretsanta")).toBe(false);
    expect(isSensitiveKey("model")).toBe(false);
  });

  it("handles circular config values from YAML aliases", () => {
    const config: Record<string, unknown> = { model: "m", api_key: "opaque" };
    config.self = config;
    expect(redactJsonValue(config)).toEqual({
      model: "m",
      api_key: "<redacted>",
      self: "[Circular]",
    });
  });
});

describe("redactJsonLines", () => {
  it("redacts structured lines and falls back for malformed ones", () => {
    const lines = [
      JSON.stringify({
        role: "user",
        content: `use ${fakeSecret("anthropic")} now`,
        apiKey: "leak-me-please",
      }),
      `plain text with ${fakeSecret("aws")} inside`,
      "",
      `{broken json with ${fakeSecret("github")}`,
    ];
    const out = redactJsonLines(lines.join("\n"));
    for (const kind of ["anthropic", "aws", "github"] as const) {
      expect(out, `${kind} secret survived redaction`).not.toContain(
        fakeSecret(kind),
      );
    }
    expect(out).not.toContain("leak-me-please");
    // structure preserved: still 4 lines, empty line kept
    expect(out.split("\n")).toHaveLength(4);
    expect(out.split("\n")[2]).toBe("");
  });
});
