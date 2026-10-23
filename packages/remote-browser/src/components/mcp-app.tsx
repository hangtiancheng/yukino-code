import {
  AppBridge,
  PostMessageTransport,
  McpUiResourceMetaSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  ReadResourceResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpApp } from "@yukino.js/mcp/apps.js";
import { MCP_APP_MIME_TYPE } from "@yukino.js/mcp/constants.js";
import { useContext, useEffect, useRef, useState } from "react";

import {
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_TEARDOWN_TIMEOUT_MS,
  MCP_APP_RESOURCE_MISSING,
  MCP_APP_FRAME_MISSING,
  MCP_APP_MESSAGE_FAILED,
  MCP_APP_LINK_BLOCKED,
  MCP_APP_RETRY,
  MCP_APP_MIN_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  MCP_APP_HOST_INFO,
  MCP_APP_LOADING,
  MCP_APP_INITIALIZE_TIMEOUT,
  MCP_APP_INITIALIZE_TIMEOUT_MS,
} from "#/constants.js";
import { McpAppContext } from "#/lib/mcp-app-context.js";
import { buildAppCsp } from "#/lib/mcp-app-sandbox.js";

function sandboxAppHtml(html: string, csp?: McpUiResourceCsp): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const base of doc.querySelectorAll("base")) {
    base.remove();
  }
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = buildAppCsp(csp);
  doc.head.prepend(policy);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
export function McpAppView({ appId, app }: { appId: string; app: McpApp }) {
  const host = useContext(McpAppContext);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const updateContextRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const themeRef = useRef(host?.theme ?? "dark");
  themeRef.current = host?.theme ?? "dark";
  const request = host?.request;
  const sendMessage = host?.sendMessage;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !request || !sendMessage) {
      return;
    }
    let disposed = false;
    let expired = false;
    let initialized = false;
    let bridge: AppBridge | undefined;
    let observer: ResizeObserver | undefined;
    setLoading(true);
    setError(null);
    const fail = (reason: unknown) => {
      if (!disposed) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    const timeout = setTimeout(() => {
      expired = true;
      fail(new Error(MCP_APP_INITIALIZE_TIMEOUT));
      void bridge?.close();
    }, MCP_APP_INITIALIZE_TIMEOUT_MS);

    const load = async () => {
      const result = ReadResourceResultSchema.parse(
        await request(appId, {
          method: "read_resource",
          params: { uri: app.resourceUri },
        }),
      );
      if (disposed || expired) {
        return;
      }
      const resource = result.contents.find(
        (item) =>
          item.uri === app.resourceUri && item.mimeType === MCP_APP_MIME_TYPE,
      );
      if (!resource) {
        throw new Error(MCP_APP_RESOURCE_MISSING);
      }
      const html =
        "text" in resource
          ? resource.text
          : new TextDecoder().decode(
              Uint8Array.from(atob(resource.blob), (char) =>
                char.charCodeAt(0),
              ),
            );
      const meta = McpUiResourceMetaSchema.parse(resource._meta?.ui ?? {});
      const target = iframe.contentWindow;
      if (!target) {
        throw new Error(MCP_APP_FRAME_MISSING);
      }
      const readContext = () => ({
        theme: themeRef.current,
        displayMode: "inline" as const,
        availableDisplayModes: ["inline" as const],
        platform: "web" as const,
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        containerDimensions: {
          width: iframe.clientWidth,
          maxHeight: MCP_APP_MAX_HEIGHT,
        },
      });
      bridge = new AppBridge(
        null,
        MCP_APP_HOST_INFO,
        {
          serverTools: {},
          serverResources: {},
          openLinks: {},
          message: { text: {} },
          sandbox: { permissions: {}, csp: meta.csp },
        },
        { hostContext: readContext() },
      );
      const updateContext = () => {
        if (initialized && !disposed) {
          bridge?.setHostContext(readContext());
        }
      };
      updateContextRef.current = updateContext;
      observer = new ResizeObserver(updateContext);
      observer.observe(iframe);
      bridge.oncalltool = async (params) =>
        CallToolResultSchema.parse(
          await request(appId, {
            method: "call_tool",
            params: { name: params.name, arguments: params.arguments },
          }),
        );
      bridge.onreadresource = async ({ uri }) =>
        ReadResourceResultSchema.parse(
          await request(appId, { method: "read_resource", params: { uri } }),
        );
      bridge.onmessage = ({ content }) => {
        const text = content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        if (!text || !sendMessage(text)) {
          throw new Error(MCP_APP_MESSAGE_FAILED);
        }
        return Promise.resolve({});
      };
      bridge.onopenlink = ({ url }) => {
        const target = new URL(url);
        if (target.protocol !== "https:" && target.protocol !== "http:") {
          throw new Error(MCP_APP_LINK_BLOCKED);
        }
        window.open(target.href, "_blank", "noopener,noreferrer");
        return Promise.resolve({});
      };
      bridge.addEventListener("sizechange", ({ height: nextHeight }) => {
        if (nextHeight !== undefined && Number.isFinite(nextHeight)) {
          setHeight(
            Math.min(
              MCP_APP_MAX_HEIGHT,
              Math.max(MCP_APP_MIN_HEIGHT, Math.ceil(nextHeight)),
            ),
          );
        }
      });
      bridge.addEventListener("initialized", () => {
        if (disposed || expired) {
          return;
        }
        initialized = true;
        updateContext();
        clearTimeout(timeout);
        setLoading(false);
        void (async () => {
          await bridge?.sendToolInput({ arguments: app.arguments });
          await bridge?.sendToolResult(app.result);
        })().catch(fail);
      });
      bridge.onerror = fail;
      await bridge.connect(new PostMessageTransport(target, target));
      if (!disposed) {
        iframe.srcdoc = sandboxAppHtml(html, meta.csp);
      }
    };
    void load().catch((reason: unknown) => {
      clearTimeout(timeout);
      fail(reason);
    });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      observer?.disconnect();
      updateContextRef.current = null;
      if (bridge) {
        const current = bridge;
        void (
          initialized
            ? current.teardownResource(
                {},
                { timeout: MCP_APP_TEARDOWN_TIMEOUT_MS },
              )
            : Promise.resolve()
        )
          .catch(() => undefined)
          .finally(() => current.close());
      }
    };
  }, [appId, app, request, sendMessage, attempt]);

  useEffect(() => {
    updateContextRef.current?.();
  }, [host?.theme]);

  return (
    <section
      aria-label={app.toolName}
      className="mx-3 mb-4 overflow-hidden rounded border border-border sm:mx-5"
    >
      {loading && (
        <p role="status" className="p-3 text-xs text-dim">
          {MCP_APP_LOADING}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 p-3 text-xs text-red"
        >
          <span>{error}</span>
          <button
            type="button"
            className="ml-auto cursor-pointer text-bright underline"
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            {MCP_APP_RETRY}
          </button>
        </div>
      )}
      <iframe
        key={attempt}
        ref={iframeRef}
        title={`${app.toolName} app`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={error ? "hidden" : "block w-full border-0"}
        style={{ height }}
      />
    </section>
  );
}
