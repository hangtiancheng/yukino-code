import { describe, expect, it } from "vitest";

import { CLI_HELP, CliUsageError, parseCliArgs, UPDATE_HELP } from "@/cli.js";

describe("CLI argument parsing", () => {
  it("defaults to the interactive UI", () => {
    expect(parseCliArgs([])).toEqual({ kind: "ui" });
    expect(parseCliArgs(["--"])).toEqual({ kind: "ui" });
  });

  it("parses resume requests", () => {
    expect(parseCliArgs(["--resume"])).toEqual({ kind: "ui", resume: true });
    expect(parseCliArgs(["--resume", "session-123"])).toEqual({
      kind: "ui",
      resume: "session-123",
    });
    expect(parseCliArgs(["--resume=session-456"])).toEqual({
      kind: "ui",
      resume: "session-456",
    });
    expect(parseCliArgs(["--resume="])).toEqual({ kind: "ui", resume: true });
  });

  it("short-circuits to help and version", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--remote", "--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--help", "update"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("parses print mode with either --output-format order", () => {
    expect(parseCliArgs(["-p", "task"])).toEqual({
      kind: "print",
      prompt: "task",
      outputFormat: "text",
    });
    expect(
      parseCliArgs(["-p", "task", "--output-format", "stream-json"]),
    ).toEqual({ kind: "print", prompt: "task", outputFormat: "stream-json" });
    expect(
      parseCliArgs(["--output-format", "stream-json", "-p", "task"]),
    ).toEqual({ kind: "print", prompt: "task", outputFormat: "stream-json" });
  });

  it("treats flag-like prompt text after '-p --' as data", () => {
    expect(parseCliArgs(["-p", "--", "--remote"])).toEqual({
      kind: "print",
      prompt: "--remote",
      outputFormat: "text",
    });
    expect(
      parseCliArgs(["--output-format", "stream-json", "-p", "--", "--remote"]),
    ).toEqual({
      kind: "print",
      prompt: "--remote",
      outputFormat: "stream-json",
    });
  });

  it.each<[string[]]>([
    [["-p"]],
    [["-p", "--"]],
    [["-p", ""]],
    [["-p", "   "]],
    [["-p", "--", ""]],
    [["-p", "--", "  "]],
    [["-p", "--output-format", "stream-json", "actual prompt"]],
  ])("rejects -p without an immediate prompt (%j)", (args) => {
    expect(() => parseCliArgs(args)).toThrow(
      "requires a prompt argument immediately",
    );
  });

  it.each<[string[]]>([
    [["-p", "task", "--output-format"]],
    [["-p", "task", "--output-format", "json"]],
  ])("rejects --output-format when its value is unusable (%j)", (args) => {
    expect(() => parseCliArgs(args)).toThrow(
      "requires 'text' or 'stream-json'",
    );
  });

  it("rejects --output-format without -p", () => {
    expect(() => parseCliArgs(["--output-format", "text"])).toThrow(
      "--output-format requires -p.",
    );
  });

  it("parses server modes with optional addresses", () => {
    expect(parseCliArgs(["--remote"])).toEqual({
      kind: "remote",
      address: "18888",
    });
    expect(parseCliArgs(["--remote", "9000"])).toEqual({
      kind: "remote",
      address: "9000",
    });
    expect(parseCliArgs(["--remote", "0.0.0.0:9000"])).toEqual({
      kind: "remote",
      address: "0.0.0.0:9000",
    });
    expect(parseCliArgs(["--a2a"])).toEqual({ kind: "a2a" });
    expect(parseCliArgs(["--a2a", "127.0.0.1:9000"])).toEqual({
      kind: "a2a",
      address: "127.0.0.1:9000",
    });
  });

  it.each<[string[], string]>([
    [["-p", "task", "--remote"], "--remote cannot be combined with -p."],
    [["--remote", "-p", "task"], "-p cannot be combined with --remote."],
    [["--a2a", "--remote"], "--remote cannot be combined with --a2a."],
    [["--resume", "--remote"], "--remote cannot be combined with --resume."],
    [["-p", "task", "--resume"], "--resume cannot be combined with -p."],
    [["--resume", "-p", "task"], "-p cannot be combined with --resume."],
    [["--a2a", "9000", "9001"], 'Unexpected argument "9001".'],
    [["--remote", "--remote"], "Option '--remote' was already specified."],
    [["-p", "a", "-p", "b"], "Option '-p' was already specified."],
  ])("rejects incompatible combinations %j", (args, message) => {
    expect(() => parseCliArgs(args)).toThrow(CliUsageError);
    expect(() => parseCliArgs(args)).toThrow(message);
  });

  it("rejects unknown options and stray arguments", () => {
    expect(() => parseCliArgs(["--bogus"])).toThrow(
      'Unknown option "--bogus".',
    );
    expect(() => parseCliArgs(["stray"])).toThrow(
      'Unexpected argument "stray".',
    );
    expect(() => parseCliArgs(["--", "-p", "task"])).toThrow(
      'Unexpected argument "-p".',
    );
    expect(() => parseCliArgs(["-p", "--", "task", "extra"])).toThrow(
      'Unexpected argument "extra".',
    );
  });

  it("parses the update subcommand", () => {
    expect(parseCliArgs(["update"])).toEqual({ kind: "update" });
    expect(parseCliArgs(["update", "--tag", "canary"])).toEqual({
      kind: "update",
      tag: "canary",
    });
    expect(parseCliArgs(["update", "--tag=canary"])).toEqual({
      kind: "update",
      tag: "canary",
    });
    expect(parseCliArgs(["update", "--tag=a", "--tag=b"])).toEqual({
      kind: "update",
      tag: "b",
    });
    expect(parseCliArgs(["update", "--help"])).toEqual({
      kind: "help",
      topic: "update",
    });
    expect(parseCliArgs(["update", "-h"])).toEqual({
      kind: "help",
      topic: "update",
    });
    expect(parseCliArgs(["update", "--tag=canary", "--help"])).toEqual({
      kind: "help",
      topic: "update",
    });
  });

  it.each<[string[]]>([
    [["update", "unexpected"]],
    [["update", "--unknown"]],
    [["update", "--tag"]],
    [["update", "--tag", "--help"]],
  ])("rejects invalid update arguments %j with the update usage", (args) => {
    expect(() => parseCliArgs(args)).toThrow(CliUsageError);
    expect(() => parseCliArgs(args)).toThrow("Usage: yukino update");
  });

  it("documents every top-level flag and the in-session /help", () => {
    for (const fragment of [
      "-h, --help",
      "-v, --version",
      "-p <prompt>",
      "--output-format",
      "--resume",
      "--remote",
      "--a2a",
      "update [--tag <tag>]",
      "Type /help inside a session",
    ]) {
      expect(CLI_HELP, fragment).toContain(fragment);
    }
    expect(UPDATE_HELP).toContain(
      "--tag <tag>  npm dist-tag to check (default: latest)",
    );
  });
});
