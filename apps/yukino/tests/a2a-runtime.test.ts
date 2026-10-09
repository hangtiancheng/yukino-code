import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createA2aRuntime } from "@/a2a/executor.js";
import * as config from "@/config/index.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import { MCPManager } from "@/mcp/manager.js";
import * as remote from "@/remote/server.js";

describe("A2A runtime cleanup", () => {
  it.each([false, true])(
    "releases owned tools after stopping workers, even on failure: %s",
    async (failWorkers) => {
      const cwd = mkdtempSync(join(tmpdir(), "yukino-a2a-runtime-"));
      const provider: ProviderConfig = {
        name: "test",
        protocol: "openai",
        model: "test",
        base_url: "https://test.invalid",
        api_key: "test",
      };
      const handle = await remote.createRemoteAgent({
        provider,
        cwd,
        enableCoordinatorMode: false,
        forkDisabled: true,
        memoryEnabled: false,
      });
      const abort = vi
        .spyOn(handle, "abort")
        .mockImplementation(() => undefined);
      const trace: string[] = [];
      let release: () => void = () => undefined;
      const workersStopped = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stopAll = vi
        .spyOn(handle.backgroundTaskManager, "stopAll")
        .mockImplementation(async () => {
          trace.push("stop workers");
          await workersStopped;
          if (failWorkers) {
            throw new Error("expected cleanup failure");
          }
          trace.push("workers stopped");
        });
      const teamDispose = vi.spyOn(handle.teamManager, "dispose");
      handle.mcpManager = new MCPManager();
      const mcpDispose = vi
        .spyOn(handle.mcpManager, "disconnectAll")
        .mockImplementation(() => {
          trace.push("disconnect MCP");
          return Promise.resolve();
        });
      const registryDispose = vi
        .spyOn(handle.registry, "dispose")
        .mockImplementation(() => {
          trace.push("dispose tools");
          return Promise.resolve();
        });
      vi.spyOn(config, "loadConfig").mockReturnValue({
        default_provider: 0,
        providers: [provider],
        hooks: [],
        mcp_servers: [],
        enable_memory: false,
      });
      vi.spyOn(remote, "createRemoteAgent").mockResolvedValue(handle);
      try {
        const runtime = await createA2aRuntime(cwd);
        expect(remote.createRemoteAgent).toHaveBeenCalledWith(
          expect.objectContaining({ interactionMode: "non-interactive" }),
        );
        const cleanup = runtime.dispose().catch((error: unknown) => error);
        expect(abort).toHaveBeenCalledOnce();
        expect(stopAll).toHaveBeenCalledOnce();
        expect(registryDispose).not.toHaveBeenCalled();
        expect(mcpDispose).not.toHaveBeenCalled();
        release();
        await expect(cleanup).resolves.toBeUndefined();
        expect(teamDispose).toHaveBeenCalledOnce();
        expect(registryDispose).toHaveBeenCalledOnce();
        expect(mcpDispose).toHaveBeenCalledOnce();
        expect(trace.at(-1)).toBe("dispose tools");
      } finally {
        release();
        vi.restoreAllMocks();
        await handle.teamManager.dispose();
        await handle.registry.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
