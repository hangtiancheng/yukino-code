import { stripVTControlCharacters } from "node:util";

import { render, renderToString, useInput, useWindowSize } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeReviewDialog } from "@/ui/code-review-dialog.js";

const inputHandlers = vi.hoisted(
  () => new Set<(text: string, key: Key) => void>(),
);
vi.mock("ink", async (importOriginal) => {
  const { useEffect } = await import("react");
  return {
    ...(await importOriginal<typeof Ink>()),
    useInput: vi.fn(
      (
        handler: (text: string, key: Key) => void,
        options?: { isActive?: boolean },
      ) => {
        useEffect(() => {
          if (options?.isActive === false) {
            return;
          }
          inputHandlers.add(handler);
          return () => {
            inputHandlers.delete(handler);
          };
        }, [handler, options?.isActive]);
      },
    ),
    usePaste: vi.fn(),
    useWindowSize: vi.fn(),
  };
});

const noKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

let instance: Instance | undefined;
let outputChunks: string[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useInput).mockClear();
  vi.mocked(useWindowSize).mockReturnValue({ columns: 80, rows: 24 });
  outputChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      outputChunks.push(String(chunk));
      return true;
    },
  );
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(onSubmit = vi.fn(), onCancel = vi.fn()) {
  act(() => {
    instance = render(createElement(CodeReviewDialog, { onSubmit, onCancel }), {
      patchConsole: false,
      interactive: false,
      debug: true,
    });
  });
  return { onSubmit, onCancel };
}

function send(input = "", key: Partial<Key> = {}): void {
  const handlers = [...inputHandlers];
  if (handlers.length !== 2) {
    throw new Error("CodeReviewDialog input handlers are not mounted");
  }
  act(() => {
    for (const handler of handlers) {
      handler(input, { ...noKey, ...key });
    }
  });
}

function terminalOutput(): string {
  return stripVTControlCharacters(outputChunks.join(""));
}

async function submit(): Promise<void> {
  send("", { return: true });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("CodeReviewDialog", () => {
  it("persists an edit before field navigation in the same input batch", async () => {
    const { onSubmit } = mount();
    act(() => {
      send("quick focus");
      send("", { tab: true });
    });
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ background: "quick focus" }),
    );
  });

  it("renders the review scope fields", () => {
    let rendered = "";
    act(() => {
      rendered = stripVTControlCharacters(
        renderToString(
          createElement(CodeReviewDialog, {
            onSubmit: vi.fn(),
            onCancel: vi.fn(),
          }),
          { columns: 80 },
        ),
      );
    });

    expect(rendered).toContain("Code review");
    expect(rendered).toContain("Focus");
    expect(rendered).toContain("From");
    expect(rendered).toContain("To");
    expect(rendered).toContain("Commit");
    expect(rendered).toContain("Exclude globs");
  });

  it("submits workspace defaults", async () => {
    const { onSubmit } = mount();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      background: "",
      from: undefined,
      to: undefined,
      commit: undefined,
      excludePatterns: [],
    });
  });

  it("edits fields and submits range options with multiple excludes", async () => {
    const { onSubmit } = mount();
    send("auth focus");
    send("", { tab: true });
    send("main");
    send("", { tab: true });
    send("feature");
    send("", { tab: true });
    send("", { tab: true });
    send("**/*.pb.go\nfixtures/**");
    await submit();

    expect(onSubmit).toHaveBeenCalledWith({
      background: "auth focus",
      from: "main",
      to: "feature",
      commit: undefined,
      excludePatterns: ["**/*.pb.go", "fixtures/**"],
    });
  });

  it("shows conditional and mutually exclusive ref errors", async () => {
    const { onSubmit } = mount();
    send("", { tab: true });
    send("main");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(terminalOutput()).toContain("To is required when From is set");

    send("", { tab: true });
    send("feature");
    send("", { tab: true });
    send("abc123");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(terminalOutput()).toContain(
      "Commit cannot be combined with From/To",
    );
  });

  it("cancels with Escape", () => {
    const { onCancel } = mount();
    send("\x1b", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
