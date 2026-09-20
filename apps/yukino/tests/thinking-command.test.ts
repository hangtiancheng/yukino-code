/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, expect, it, vi } from "vitest";

import { createDefaultRegistry, parse } from "@/commands/commands.js";
import type { ThinkingLevel } from "@/config/index.js";

describe("/thinking command", () => {
  const registry = createDefaultRegistry();
  const command = registry.find("thinking");

  it("is registered as a local command", () => {
    expect(command?.type).toBe("local");
  });

  it("shows the current level when called without args", () => {
    const output = command?.handler({
      workDir: "/tmp",
      args: "",
      thinkingLevel: () => "medium",
    });
    expect(output).toContain("medium");
  });

  it("sets a valid level", () => {
    const setThinkingLevel = vi.fn();
    const output = command?.handler({
      workDir: "/tmp",
      args: "max",
      setThinkingLevel,
    });
    expect(setThinkingLevel).toHaveBeenCalledWith("max");
    expect(output).toContain("max");
  });

  it("rejects an unknown level", () => {
    const setThinkingLevel = vi.fn();
    const output = command?.handler({
      workDir: "/tmp",
      args: "bogus",
      setThinkingLevel,
    });
    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(output).toContain("Unknown thinking level");
  });

  it("persists the level when a persistence hook is provided", () => {
    const setThinkingLevel = vi.fn();
    const persistThinkingLevel = vi.fn();
    const output = command?.handler({
      workDir: "/tmp",
      args: "low",
      setThinkingLevel,
      persistThinkingLevel,
    });
    expect(setThinkingLevel).toHaveBeenCalledWith("low");
    expect(persistThinkingLevel).toHaveBeenCalledWith("low");
    expect(output).toContain("saved");
  });

  it("keeps the runtime change but reports a persistence failure", () => {
    const setThinkingLevel = vi.fn();
    const persistThinkingLevel = vi.fn(() => {
      throw new Error("boom");
    });
    const output = command?.handler({
      workDir: "/tmp",
      args: "low",
      setThinkingLevel,
      persistThinkingLevel,
    });
    expect(setThinkingLevel).toHaveBeenCalledWith("low");
    expect(output).toContain("saving failed");
    expect(output).toContain("boom");
  });

  it("uses the same control for the /think alias", () => {
    expect(registry.find("think")).toBe(command);
  });

  it("shows only available choices in usage and errors", () => {
    for (const args of ["", "bogus", "max"]) {
      const setThinkingLevel = vi.fn();
      const persistThinkingLevel = vi.fn();
      const output = command?.handler({
        workDir: "/tmp",
        args,
        thinkingLevel: () => "off",
        availableThinkingLevels: () => ["off", "low"],
        setThinkingLevel,
        persistThinkingLevel,
      });
      expect(output).toContain(
        args ? "Available levels: off, low" : "Usage: /thinking <off | low>",
      );
      expect(output).not.toContain("medium");
      expect(setThinkingLevel).not.toHaveBeenCalled();
      expect(persistThinkingLevel).not.toHaveBeenCalled();
    }
  });

  it.each([new Error("provider is busy"), new TypeError("provider is busy")])(
    "does not save after a runtime setter failure: %s",
    (error) => {
      const persistThinkingLevel = vi.fn();
      const level: ThinkingLevel = "high";
      const output = command?.handler({
        workDir: "/tmp",
        args: "low",
        thinkingLevel: () => level,
        setThinkingLevel: () => {
          throw error;
        },
        persistThinkingLevel,
      });
      expect(output).toContain("Unable to set thinking level");
      expect(output).toContain("provider is busy");
      expect(output).toContain("Try /thinking");
      expect(output).not.toContain("Thinking level set to");
      expect(persistThinkingLevel).not.toHaveBeenCalled();
      expect(level).toBe("high");
    },
  );

  it("reports and persists the effective level after a lower-level clamp", () => {
    let level: ThinkingLevel = "high";
    const persistThinkingLevel = vi.fn();
    const output = command?.handler({
      workDir: "/tmp",
      args: "max",
      thinkingLevel: () => level,
      setThinkingLevel: () => {
        level = "medium";
      },
      persistThinkingLevel,
    });
    expect(persistThinkingLevel).toHaveBeenCalledWith("medium");
    expect(output).toBe("Thinking level set to medium (requested max) and saved.");
  });

  it("keeps the effective runtime level when saving fails", () => {
    let level: ThinkingLevel = "high";
    const output = command?.handler({
      workDir: "/tmp",
      args: "max",
      thinkingLevel: () => level,
      setThinkingLevel: () => {
        level = "low";
      },
      persistThinkingLevel: () => {
        throw new Error("read-only config");
      },
    });
    expect(level).toBe("low");
    expect(output).toContain("set to low (requested max) for this session");
    expect(output).toContain("saving failed: read-only config");
  });

  it("reports unavailable runtime control without attempting to save", () => {
    const persistThinkingLevel = vi.fn();
    expect(command?.handler({ workDir: "/tmp", args: "low", persistThinkingLevel })).toContain(
      "control is not available",
    );
    expect(persistThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["/thinking\tlow", "/thinking\nlow", "/thinking\r\n low", "/think  \t LOW \n"])(
    "parses whitespace and executes %s",
    (input) => {
      const parsed = parse(input);
      expect(parsed?.args.toLowerCase()).toBe("low");
      const setThinkingLevel = vi.fn();
      registry.find(parsed?.name ?? "")?.handler({
        workDir: "/tmp",
        args: parsed?.args ?? "",
        setThinkingLevel,
      });
      expect(setThinkingLevel).toHaveBeenCalledWith("low");
    },
  );

  it.each([
    "/tmp/file.ts",
    "/tmp/file.ts\tlow",
    "/Users/test/My Folder/file.ts",
    "/tmp/folder\nmessage",
  ])("does not treat absolute path %s as a command", (input) => {
    expect(parse(input)).toBeNull();
  });
});
