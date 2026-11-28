import { describe, expect, it } from "vitest";

import { CLI_HELP, CliUsageError, parseCliArgs, UPDATE_HELP } from "@/cli.js";

describe("CLI argument parsing", () => {
  it("keeps maintenance and default modes independent of configuration", () => {
    expect(parseCliArgs([])).toEqual({ kind: "ui" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["update", "--tag=canary"])).toEqual({
      kind: "update",
      tag: "canary",
    });
    expect(parseCliArgs(["update", "--help"])).toEqual({
      kind: "help",
      topic: "update",
    });
  });

  it("supports print resume without changing global settings", () => {
    expect(parseCliArgs(["-p", "continue", "--resume", "session-123"])).toEqual(
      {
        kind: "print",
        prompt: "continue",
        outputFormat: "text",
        options: { sessionId: "session-123" },
      },
    );
    expect(parseCliArgs(["--resume"])).toEqual({ kind: "ui", resume: true });
    expect(parseCliArgs(["--continue", "-p", "task"])).toMatchObject({
      options: { continue: true },
    });
  });

  it("parses invocation controls and tool restrictions", () => {
    expect(
      parseCliArgs([
        "--rpc",
        "--cwd",
        "/workspace",
        "--provider",
        "local",
        "--model",
        "model",
        "--thinking",
        "high",
        "--tools",
        "ReadFile,Grep",
        "--exclude-tools",
        "Bash",
        "--trust-project",
      ]),
    ).toEqual({
      kind: "rpc",
      options: {
        cwd: "/workspace",
        provider: "local",
        model: "model",
        thinking: "high",
        tools: ["ReadFile", "Grep"],
        excludeTools: ["Bash"],
        trustProject: true,
      },
    });
    expect(
      parseCliArgs([
        "-p",
        "task",
        "--no-tools",
        "--no-persist",
        "--no-project-resources",
      ]),
    ).toMatchObject({
      options: { tools: [], persist: false, noProjectResources: true },
    });
  });

  it("treats arguments after the separator as prompt data", () => {
    expect(parseCliArgs(["--", "--remote", "extra"])).toEqual({
      kind: "print",
      prompt: "--remote extra",
      outputFormat: "text",
    });
    expect(parseCliArgs(["--", "explain", "--this"])).toEqual({
      kind: "print",
      prompt: "explain --this",
      outputFormat: "text",
    });
    expect(
      parseCliArgs([
        "-p",
        "-",
        "--attachment",
        "one.txt",
        "--attachment",
        "two.png",
      ]),
    ).toMatchObject({
      prompt: "",
      options: { stdin: true, attachments: ["one.txt", "two.png"] },
    });
  });

  it("parses stream output, server addresses and prompt files", () => {
    expect(
      parseCliArgs(["--output-format", "stream-json", "-p", "task"]),
    ).toEqual({ kind: "print", prompt: "task", outputFormat: "stream-json" });
    expect(parseCliArgs(["--remote"])).toEqual({
      kind: "remote",
      address: "18888",
    });
    expect(parseCliArgs(["--a2a", "127.0.0.1:9000"])).toEqual({
      kind: "a2a",
      address: "127.0.0.1:9000",
    });
    expect(
      parseCliArgs([
        "-p",
        "task",
        "--system-prompt-file",
        "system.txt",
        "--append-system-prompt-file",
        "extra.txt",
      ]),
    ).toMatchObject({
      options: {
        systemPromptFile: "system.txt",
        appendSystemPromptFile: "extra.txt",
      },
    });
  });

  it.each(
    [
      ["-p"],
      ["-p", ""],
      ["--model"],
      ["--rpc", "-p", "task"],
      ["--rpc", "--stdin"],
      ["--remote", "--a2a"],
      ["--resume", "-p", "task"],
      ["--session", "id", "--continue"],
      ["--tools", "ReadFile", "--no-tools"],
      ["--tools", "ReadFile,,Grep"],
      ["--trust-project", "--no-project-resources"],
      ["--no-persist", "--session", "id"],
      ["--thinking", "invalid"],
      ["--permission-mode", "invalid"],
      ["--unknown"],
      ["--output-format", "text"],
      ["-p", "task", "--output-format", "invalid"],
      ["--system-prompt", "text", "--system-prompt-file", "file.txt"],
    ].map((args) => [args]),
  )("rejects invalid or contradictory options %j", (args: string[]) => {
    expect(() => parseCliArgs(args)).toThrow(CliUsageError);
  });

  it("uses Commander conventions for repeated values and dash-prefixed prompt values", () => {
    expect(parseCliArgs(["--model", "a", "--model=b"])).toMatchObject({
      options: { model: "b" },
    });
    expect(parseCliArgs(["update", "--tag=a", "--tag=b"])).toEqual({
      kind: "update",
      tag: "b",
    });
    expect(parseCliArgs(["-p", "--literal"])).toEqual({
      kind: "print",
      prompt: "--literal",
      outputFormat: "text",
    });
    expect(parseCliArgs(["--"])).toEqual({ kind: "ui" });
  });

  it("documents the expanded public controls", () => {
    for (const flag of [
      "--rpc",
      "--resume",
      "--cwd",
      "--model",
      "--tools",
      "--no-tools",
      "--trust-project",
      "--system-prompt-file",
      "--no-persist",
      "--permission-mode",
    ]) {
      expect(CLI_HELP).toContain(flag);
    }
    expect(UPDATE_HELP).toContain("--tag <tag>");
    expect(CLI_HELP).toContain("no implicit permission bypass");
  });
});
