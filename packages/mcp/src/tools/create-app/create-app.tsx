import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

import "./global.css";
import {
  DEFAULT_FRAME_HEIGHT,
  readContentHeight,
  readHostMaxHeight,
  resolveFrameHeight,
  withHeightReporter,
} from "./frame-size.js";
import { resolveAppDocument } from "./resolve-app.js";

type RenderState =
  | { phase: "waiting" }
  | { phase: "streaming"; bytes: number }
  | { phase: "ready"; html: string; title: string }
  | { phase: "failed"; message: string };

const FALLBACK_TITLE = "MCP App";

function readStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = record?.[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function applyHostContextStyles(app: App): void {
  const ctx = app.getHostContext();
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx?.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx?.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
}

function StatusChip({
  state,
  connected,
}: {
  state: RenderState;
  connected: boolean;
}): ReactElement {
  const classes = "flex items-center gap-2 text-xs text-base-content/60";
  if (!connected) {
    return (
      <div className={classes}>
        <span aria-hidden="true" className="loading loading-dots loading-sm" />
        <span>Connecting to host&hellip;</span>
      </div>
    );
  }
  switch (state.phase) {
    case "streaming":
      return (
        <div className={classes}>
          <span
            aria-hidden="true"
            className="loading loading-spinner loading-sm"
          />
          <span>
            Generating app&hellip; {(state.bytes / 1024).toFixed(1)} KB
          </span>
        </div>
      );
    case "ready":
      return (
        <div className={classes}>
          <span
            aria-hidden="true"
            className="status status-success status-sm"
          />
          <span>Rendered</span>
        </div>
      );
    case "failed":
      return (
        <div className={classes}>
          <span aria-hidden="true" className="status status-error status-sm" />
          <span>{state.message}</span>
        </div>
      );
    case "waiting":
      return (
        <div className={classes}>
          <span
            aria-hidden="true"
            className="loading loading-dots loading-sm"
          />
          <span>Waiting for app&hellip;</span>
        </div>
      );
  }
}

function Shell(): ReactElement {
  const [state, setState] = useState<RenderState>({ phase: "waiting" });
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT);
  const inputHtmlRef = useRef<string | undefined>(undefined);
  const inputTitleRef = useRef<string | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const contentHeightRef = useRef<number | undefined>(undefined);
  const maxHeightRef = useRef(readHostMaxHeight(undefined));
  const readyHtml = state.phase === "ready" ? state.html : undefined;
  const seenHtmlRef = useRef(readyHtml);
  if (seenHtmlRef.current !== readyHtml) {
    seenHtmlRef.current = readyHtml;
    contentHeightRef.current = undefined;
    setFrameHeight(
      resolveFrameHeight({
        navHeight: navRef.current?.offsetHeight ?? 0,
        maxHeight: maxHeightRef.current,
      }),
    );
  }

  useEffect(() => {
    const app = new App(
      { name: "yukino create_app", version: "1.0.0" },
      {},
      { autoResize: false },
    );
    let stopResize: (() => void) | undefined;

    app.addEventListener("toolinputpartial", (params) => {
      const html = readStringField(params.arguments, "html");
      setState({ phase: "streaming", bytes: html?.length ?? 0 });
    });
    app.addEventListener("toolinput", (params) => {
      const html = readStringField(params.arguments, "html");
      const title = readStringField(params.arguments, "title");
      if (html !== undefined) {
        inputHtmlRef.current = html;
        inputTitleRef.current = title;
        setState({ phase: "ready", html, title: title ?? FALLBACK_TITLE });
      }
    });
    app.addEventListener("toolresult", (result) => {
      if (result.isError) {
        setState({
          phase: "failed",
          message: "The create_app tool call failed.",
        });
        return;
      }
      const document = resolveAppDocument({
        resultMeta: result._meta,
        structuredContent: result.structuredContent,
        inputHtml: inputHtmlRef.current,
        inputTitle: inputTitleRef.current,
        fallbackTitle: FALLBACK_TITLE,
      });
      if (document !== undefined) {
        setState({
          phase: "ready",
          html: document.html,
          title: document.title,
        });
      } else {
        setState({
          phase: "failed",
          message: "Tool result contained no app HTML.",
        });
      }
    });
    const syncHostMax = (
      dimensions: { height?: number; maxHeight?: number } | undefined,
    ) => {
      maxHeightRef.current = readHostMaxHeight(dimensions);
      setFrameHeight(
        resolveFrameHeight({
          contentHeight: contentHeightRef.current,
          navHeight: navRef.current?.offsetHeight ?? 0,
          maxHeight: maxHeightRef.current,
        }),
      );
    };
    app.addEventListener("hostcontextchanged", (ctx) => {
      if (ctx.theme) {
        applyDocumentTheme(ctx.theme);
      }
      if (ctx.styles?.variables) {
        applyHostStyleVariables(ctx.styles.variables);
      }
      if (ctx.styles?.css?.fonts) {
        applyHostFonts(ctx.styles.css.fonts);
      }
      syncHostMax(ctx.containerDimensions);
    });
    app.addEventListener("toolcancelled", () => {
      setState({ phase: "failed", message: "App creation was cancelled." });
    });
    app.onteardown = async () => {
      return {};
    };

    const transport = new PostMessageTransport(window.parent, window.parent);
    let cancelled = false;
    void app.connect(transport).then(
      () => {
        if (cancelled) {
          return;
        }
        stopResize = app.setupSizeChangedNotifications();
        applyHostContextStyles(app);
        syncHostMax(app.getHostContext()?.containerDimensions);
        setConnected(true);
      },
      (err: unknown) => {
        if (cancelled) {
          return;
        }
        setConnectError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
      stopResize?.();
      void transport.close();
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const contentHeight = readContentHeight(event.data);
      if (contentHeight === undefined) {
        return;
      }
      contentHeightRef.current = contentHeight;
      setFrameHeight(
        resolveFrameHeight({
          contentHeight,
          navHeight: navRef.current?.offsetHeight ?? 0,
          maxHeight: maxHeightRef.current,
        }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, []);

  if (connectError !== null) {
    return (
      <main className="flex flex-col">
        <nav className="border-b border-base-300 bg-base-200 px-3 py-1 font-semibold">
          {FALLBACK_TITLE}
        </nav>
        <div className="flex flex-1 items-center justify-center p-6">
          <div role="alert" className="alert alert-error">
            <span>Could not connect to the MCP host: {connectError}</span>
          </div>
        </div>
      </main>
    );
  }

  const title = state.phase === "ready" ? state.title : FALLBACK_TITLE;

  return (
    <main className="flex flex-col">
      <nav
        ref={navRef}
        className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-200 px-3 py-1"
      >
        <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
        <StatusChip state={state} connected={connected} />
      </nav>
      <iframe
        ref={frameRef}
        className="block w-full border-0 bg-base-100"
        style={{ height: frameHeight }}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        srcDoc={readyHtml ? withHeightReporter(readyHtml) : undefined}
        title="Rendered app"
      />
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("create_app shell markup is missing #root");
}
createRoot(rootElement).render(<Shell />);
