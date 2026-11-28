import { describe, expect, it, vi } from "vitest";

import { requestProjectTrust } from "@/session/actions.js";

describe("concise project trust prompt", () => {
  it("shows project and counts without printing hashes or skill locations", async () => {
    const ask = vi.fn((questions: { question: string }[]) =>
      Promise.resolve({ [questions[0].question]: "once" }),
    );
    const request = {
      cwd: "/project",
      identity: "identity",
      fingerprint: "a".repeat(64),
      changed: true,
      manifest: [
        {
          kind: "skills" as const,
          path: "/private/skills/one/SKILL.md",
          digest: "b".repeat(64),
        },
        {
          kind: "skills" as const,
          path: "/private/skills/two/SKILL.md",
          digest: "c".repeat(64),
        },
        {
          kind: "config" as const,
          path: "/project/config.yaml",
          digest: "d".repeat(64),
        },
      ],
    };
    expect(await requestProjectTrust(ask, request)).toBe("once");
    const question = ask.mock.calls[0][0][0].question;
    expect(question).toContain("/project");
    expect(question).toContain("skills: 2");
    expect(question).toContain("config: 1");
    expect(question).not.toMatch(/sha256|Fingerprint|SKILL\.md|[a-f0-9]{64}/);
    expect(question).not.toContain("/private/skills");
  });
});
