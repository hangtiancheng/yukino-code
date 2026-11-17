import { render } from "ink";
import { isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { globalConfigPath } from "@/config/provider-config.js";
import type * as loggerModule from "@/logger/index.js";
import { runMode } from "@/main.js";
import { writePrivateFileSync } from "@/storage/private.js";
import { detectTerminalTheme } from "@/ui/terminal-theme.js";

vi.mock("ink", () => ({
  render: vi.fn(() => ({ waitUntilExit: () => Promise.resolve() })),
}));
vi.mock("@/ui/app.js", () => ({ App: () => null }));
vi.mock("@/ui/terminal-input.js", () => ({
  TerminalInput: class {
    stdin = process.stdin;
    dispose = vi.fn();
  },
}));
vi.mock("@/ui/terminal-theme.js", () => ({
  detectTerminalTheme: vi.fn(() => Promise.resolve("dark")),
}));
vi.mock("@/ui/terminal-output.js", () => ({
  installTerminalOutput: () => () => undefined,
}));
vi.mock("@/logger/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof loggerModule>()),
  initLogger: vi.fn(),
}));
vi.mock("@/print-mode.js", () => ({ runPrintMode: vi.fn() }));
vi.mock("@/recover.js", () => ({
  recover: vi.fn(),
  recordExit: vi.fn(),
  recordError: vi.fn(),
}));
vi.mock("@/telemetry/index.js", () => ({
  initializeTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
  setTelemetryMode: vi.fn(),
  captureTelemetryError: vi.fn(),
  installRemoteTelemetrySignalHandlers: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("CLI runtime", () => {
  it("opens the interactive login UI without an existing configuration", async () => {
    await runMode({ kind: "ui" });
    expect(render).toHaveBeenCalledOnce();
    const application = vi.mocked(render).mock.calls[0]?.[0];
    if (!isValidElement<{ providers: unknown[] }>(application)) {
      throw new Error("Expected the interactive application");
    }
    expect(application.props.providers).toEqual([]);
  });

  it("passes configured theme, permissions and MCP loading to the UI", async () => {
    writePrivateFileSync(
      globalConfigPath(),
      "providers: []\npermission_mode: acceptEdits\nmcp_loading: dispatch\ntheme: light\n",
    );
    await runMode({ kind: "ui" });
    expect(detectTerminalTheme).toHaveBeenCalledWith(expect.anything(), {
      theme: "light",
    });
    const application = vi.mocked(render).mock.calls[0]?.[0];
    if (!isValidElement(application)) {
      throw new Error("Expected the interactive application");
    }
    expect(application.props).toMatchObject({
      permissionMode: "acceptEdits",
      mcpLoading: "dispatch",
    });
  });
});
