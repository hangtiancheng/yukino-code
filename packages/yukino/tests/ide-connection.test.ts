import { afterEach, describe, expect, it, vi } from "vitest";

import { connectToIde } from "@/vscode/ide-client.js";
import { detectIde } from "@/vscode/lockfile.js";

vi.mock("../src/vscode/lockfile.js", () => ({
  detectIde: vi.fn().mockResolvedValue(null),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("IDE discovery lifetime", () => {
  it("does not discover an IDE for an already cancelled UI", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await connectToIde({
        cwd: "/tmp",
        onAtMentioned: vi.fn(),
        signal: controller.signal,
      }),
    ).toBeNull();
    expect(detectIde).not.toHaveBeenCalled();
  });

  it("cancels startup polling when the terminal exits", async () => {
    vi.stubEnv("TERM_PROGRAM", "vscode");
    const controller = new AbortController();
    const connecting = connectToIde({
      cwd: "/tmp",
      onAtMentioned: vi.fn(),
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(detectIde).toHaveBeenCalledOnce();
    controller.abort();
    expect(await connecting).toBeNull();
    expect(detectIde).toHaveBeenCalledOnce();
  });
});
