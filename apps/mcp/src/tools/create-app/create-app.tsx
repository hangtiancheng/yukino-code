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

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import "./global.css";

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
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
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

  useEffect(() => {
    const app = new App({ name: "yukino create_app", version: "1.0.0" });

    app.ontoolinputpartial = (params) => {
      const html = readStringField(params.arguments, "html");
      setState({ phase: "streaming", bytes: html?.length ?? 0 });
    };
    app.ontoolinput = (params) => {
      const html = readStringField(params.arguments, "html");
      const title = readStringField(params.arguments, "title");
      if (html !== undefined) {
        setState({ phase: "ready", html, title: title ?? FALLBACK_TITLE });
      }
    };
    app.ontoolresult = (result) => {
      if (result.isError) {
        setState({
          phase: "failed",
          message: "The create_app tool call failed.",
        });
        return;
      }
      const html = readStringField(result._meta, "html");
      const title =
        readStringField(result._meta, "title") ??
        readStringField(result.structuredContent, "title");
      if (html !== undefined) {
        setState({ phase: "ready", html, title: title ?? FALLBACK_TITLE });
      } else {
        setState({
          phase: "failed",
          message: "Tool result contained no app HTML.",
        });
      }
    };
    // daisyUI themes key off the data-theme attribute, so the host theme must
    // be mirrored there; style variables and fonts stay on CSS custom props.
    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    };
    app.onteardown = async () => {
      return {};
    };

    let cancelled = false;
    void app.connect(new PostMessageTransport()).then(
      () => {
        if (cancelled) return;
        applyHostContextStyles(app);
        setConnected(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        setConnectError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (connectError !== null) {
    return (
      <main className="flex h-screen flex-col">
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
    <main className="flex h-screen flex-col">
      <nav className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-200 px-3 py-1">
        <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
        <StatusChip state={state} connected={connected} />
      </nav>
      <iframe
        className="min-h-0 w-full flex-1 border-0 bg-base-100"
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        srcDoc={state.phase === "ready" ? state.html : undefined}
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
