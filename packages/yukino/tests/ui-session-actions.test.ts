import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "@/runtime/factory.js";
import {
  executeSessionFileTool,
  requestProjectTrust,
  sessionTransferCommand,
  sessionTreeRows,
} from "@/session/actions.js";
import { SessionManager } from "@/session/manager.js";
import type { Question } from "@/tools/ask-user.js";

const directories: string[] = [];
function directory() {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-ui-session-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of directories.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const provider = {
  name: "local",
  protocol: "openai-compat" as const,
  model: "local",
  base_url: "http://127.0.0.1:1/v1",
  api_key: "local-test",
};

describe("UI session services", () => {
  it.each(["once", "persistent", "deny", "unexpected"])(
    "shows concise resource counts and fails closed for %s",
    async (answer) => {
      const request = {
        cwd: directory(),
        identity: "identity",
        fingerprint: "fingerprint",
        changed: true,
        manifest: [
          {
            kind: "extension" as const,
            path: "/repo/.yukino/plugin.js",
            digest: "digest",
          },
        ],
      };
      const ask = vi.fn((questions: Question[]) =>
        Promise.resolve({
          [questions[0].question]: answer,
        }),
      );
      expect(await requestProjectTrust(ask, request)).toBe(
        answer === "once" || answer === "persistent" ? answer : "deny",
      );
      const questions = ask.mock.calls[0][0];
      expect(questions[0].question).toContain(request.cwd);
      expect(questions[0].question).toContain("extension: 1");
      expect(questions[0].question).not.toContain(request.fingerprint);
      expect(questions[0].question).not.toContain(request.manifest[0].path);
      expect(questions[0].question).not.toContain("sha256");
    },
  );

  it("searches all branches, role filters, labels and the selected leaf", () => {
    const manager = SessionManager.create(directory(), { persist: false });
    const first = manager.append({
      role: "user",
      content: "first prompt",
      timestamp: 1,
    });
    const old = manager.append({
      role: "assistant",
      content: "old branch",
      timestamp: 2,
    });
    manager.navigate(first);
    const second = manager.append({
      role: "user",
      content: "second prompt",
      timestamp: 3,
    });
    manager.setLabel(second, "review-ready");
    expect(
      sessionTreeRows(manager.getTree(), manager.leafId).map((row) => row.id),
    ).toContain(old);
    expect(
      sessionTreeRows(manager.getTree(), manager.leafId, "role:user review"),
    ).toEqual([
      expect.objectContaining({
        id: second,
        current: true,
        label: "review-ready",
      }),
    ]);
    expect(
      sessionTreeRows(manager.getTree(), manager.leafId, "role:assistant"),
    ).toEqual([expect.objectContaining({ id: old, current: false })]);
  });

  it("delegates safe transfer and refuses overwrite without confirmation", async () => {
    const cwd = directory();
    const manager = SessionManager.create(cwd);
    manager.append({
      role: "user",
      content: "<script>unsafe()</script>",
      timestamp: 1,
    });
    const runtime = await createAgentRuntime({
      provider,
      cwd,
      sessionId: manager.id,
      enableCoordinatorMode: false,
      memoryEnabled: false,
      loadProjectResources: false,
    });
    runtime.permissionMode = "bypassPermissions";
    const permission = vi.fn().mockResolvedValue("allow");
    const ask = vi.fn().mockResolvedValue({});
    const path = join(cwd, "export.html");
    try {
      await sessionTransferCommand(
        "export",
        "export.html --html",
        runtime,
        manager,
        ask,
        permission,
      );
      expect(readFileSync(path, "utf8")).toContain("&lt;script&gt;");
      writeFileSync(path, "keep this file");
      await expect(
        sessionTransferCommand(
          "export",
          "export.html --html",
          runtime,
          manager,
          ask,
          permission,
        ),
      ).rejects.toThrow("Overwrite canceled");
      expect(readFileSync(path, "utf8")).toBe("keep this file");
      const exported = await sessionTransferCommand(
        "export",
        "export.jsonl --all",
        runtime,
        manager,
        ask,
        permission,
      );
      expect(exported.message).toContain("export.jsonl");
      const imported = await sessionTransferCommand(
        "import",
        "export.jsonl",
        runtime,
        manager,
        ask,
        permission,
      );
      expect(imported.manager?.id).not.toBe(manager.id);
      expect(imported.manager?.getMessages()[0].content).toBe(
        "<script>unsafe()</script>",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("revalidates real WriteFile authorization after permission approval", async () => {
    const cwd = directory();
    const runtime = await createAgentRuntime({
      provider,
      cwd,
      persist: false,
      enableCoordinatorMode: false,
      memoryEnabled: false,
      loadProjectResources: false,
    });
    vi.spyOn(runtime.checker, "check").mockReturnValue({
      effect: "ask",
      reason: "test approval",
    });
    const tool = runtime.registry.get("WriteFile");
    if (!tool) {
      throw new Error("Missing WriteFile");
    }
    const write = vi.spyOn(tool, "execute");
    const permission = vi.fn(() => {
      runtime.registry.setPolicy({ denylist: ["WriteFile"] });
      return Promise.resolve("allow" as const);
    });
    try {
      await expect(
        executeSessionFileTool(
          runtime,
          "WriteFile",
          { file_path: join(cwd, "denied.txt"), content: "denied" },
          permission,
        ),
      ).rejects.toThrow("authorization revoked");
      expect(permission).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
